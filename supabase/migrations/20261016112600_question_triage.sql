-- «KURATORGA SAVOLLAR»: only messages that need a teacher become questions (owner, 2026-10-16: "even 'hi', 'hello'
-- are sent to the teacher as unanswered questions … send only the ones that need explanation").
--
-- Measured (7 days, 349 rows): greetings, thanks after an answer («Хаа Рахмат», «хоп чунарли»), students chatting
-- with each other, commands, bare links — every one became a question, was reminded, and counted. The question
-- assistant's 'chatter' label cannot be reused to hide them: it called real questions chatter («Assalomu aleykum …
-- nimaga promptni …» 0.86, «Буни ташлаганмисизлар топа олмаяпман»).
--
-- New: a TRIAGE step per question, run by the question-triage edge function (every minute, after 90 s of quiet):
--   1. rules   — a command, no letters, or a message that is ONLY greetings / thanks / "got it" (+ "ustoz", "opa" …),
--                or a short thanks right after the student's own question was answered → not a question;
--                a screenshot/file with no words → a question (never hidden);
--   2. AI      — everything else: ONE decision with the topic's last messages as context — "does this need a
--                teacher's explanation?" (a greeting + a question IS a question; a problem with no "?" IS a question).
--   3. apply   — hidden (status 'dismissed', triage 'not_question') only when the rule fired or the AI is ≥ min_conf
--                (0.8) sure; anything unsure, and any AI failure, stays a question — a real question is never lost.
-- 'dismissed' is already excluded by every reader (inbox, reminders, assistant, curator stats, watchdogs read 'open').
-- Teachers see the hidden ones in ❓ Savollar → «🙈 Yashirilgan» and restore one with «↩️ Bu savol»; a question card
-- has «🙅 Savol emas» (both marked triage_by 'teacher' — the ground truth for measuring the AI).
--
-- Rollout: mode 'shadow' (record only) + a 7-day backfill so the verdicts can be checked against real messages
-- before anything is hidden; then platform_settings.question_triage.mode = 'live'. Kill-switch: enabled.
-- Detector: question_triage_watchdog (hourly :37) — open questions left untriaged > 15 min while enabled → admins.
--
-- Also: 3-GURUH — Barno covers while Feruza is away (Barno is already the primary curator). Feruza's co-curator link is
-- removed so she stops receiving 3-GURUH notifications; the removed row is recorded for restoring her later.

alter table public.teacher_questions
  add column if not exists triage text check (triage in ('question', 'not_question')),
  add column if not exists triage_kind text,
  add column if not exists triage_by text check (triage_by in ('rule', 'ai', 'fallback', 'teacher')),
  add column if not exists triage_conf numeric,
  add column if not exists triage_reason text,
  add column if not exists triage_at timestamptz,
  add column if not exists triage_cost_usd numeric,
  add column if not exists triage_lease_until timestamptz;

create index if not exists teacher_questions_triage_todo_idx on public.teacher_questions (asked_at) where triage is null;

insert into public.platform_settings (key, value, updated_at)
values ('question_triage', jsonb_build_object(
  'enabled', true, 'mode', 'shadow', 'min_conf', 0.8, 'settle_sec', 90, 'max_per_run', 20,
  'ai_daily_budget_usd', 1, 'ack_window_min', 60, 'ai_provider_order', jsonb_build_array('openai', 'anthropic'),
  'backfill_since', to_char((now() - interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now())
on conflict (key) do nothing;

-- Claim up to _limit questions to triage, with what the classifier needs. Leases them for 5 minutes.
--   live work: open, untriaged, quiet for settle_sec, asked in the last 24 h
--   backfill:  untriaged, asked since settings.backfill_since, any status (an open one only once quiet too); an
--              answered/expired one is only recorded — hiding applies to open questions only
create or replace function public.question_triage_claim(_limit int)
returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with cfg as (
    select coalesce((value->>'settle_sec')::int, 90) settle, coalesce((value->>'ack_window_min')::int, 60) ack,
           case when coalesce(value->>'backfill_since', '') ~ '^\d{4}-\d{2}-\d{2}' then (value->>'backfill_since')::timestamptz end since
      from public.platform_settings where key = 'question_triage'),
  picked as (
    select q.id from public.teacher_questions q, cfg
     where q.triage is null
       and (q.triage_lease_until is null or q.triage_lease_until < now())
       and ((q.status = 'open' and q.last_msg_at < now() - make_interval(secs => cfg.settle) and q.asked_at > now() - interval '24 hours')
            or (cfg.since is not null and q.asked_at >= cfg.since
                and (q.status <> 'open' or q.last_msg_at < now() - make_interval(secs => cfg.settle))))
     order by (q.status = 'open') desc, q.asked_at desc
     limit greatest(1, least(_limit, 50))
     for update of q skip locked),
  leased as (
    update public.teacher_questions t set triage_lease_until = now() + interval '5 minutes'
      from picked where t.id = picked.id
    returning t.*)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'group_id', q.group_id, 'chat_id', q.chat_id, 'thread_id', q.thread_id, 'tg_user_id', q.tg_user_id,
      'status', q.status, 'text', q.text, 'media_count', coalesce(jsonb_array_length(q.media), 0), 'last_msg_at', q.last_msg_at,
      'asked_at', q.asked_at, 'first_message_id', q.first_message_id,
      -- the same student's previous question in this group, answered shortly before this one was asked
      'prev_answered_min', (select round(extract(epoch from (q.asked_at - p.answered_at)) / 60)
                              from public.teacher_questions p, cfg
                             where p.group_id = q.group_id and p.tg_user_id = q.tg_user_id and p.id <> q.id
                               and p.status = 'answered' and p.answered_at <= q.asked_at
                               and p.answered_at > q.asked_at - make_interval(mins => cfg.ack)
                             order by p.answered_at desc limit 1),
      -- the topic's last messages before this one (oldest first): who wrote them and what
      'context', coalesce((
        select jsonb_agg(c.item order by c.mid) from (
          select w.message_id mid, jsonb_build_object(
                   'who', case when w.from_user_id = q.tg_user_id then 'STUDENT'
                               when w.from_user_id = 1087968824 or (w.raw_update#>>'{message,sender_chat,id}') = q.chat_id::text then 'CURATOR'
                               when exists (select 1 from public.profiles sp join public.user_roles r on r.user_id = sp.id
                                             where sp.telegram_id = w.from_user_id and r.role in ('teacher', 'admin', 'superadmin')) then 'CURATOR'
                               else 'OTHER_STUDENT' end,
                   'text', left(coalesce(w.text_preview, ''), 240)) item
            from public.webhook_inbox w
           where w.chat_id = q.chat_id and w.message_id < q.first_message_id and w.message_id > q.first_message_id - 400
             and coalesce(w.message_thread_id, 0) = coalesce(q.thread_id, 0)
             and coalesce(w.text_preview, '') <> ''
           order by w.message_id desc limit 6) c), '[]'::jsonb)
    ) order by q.asked_at desc), '[]'::jsonb)
  from leased q;
$function$;

-- Record a verdict; in live mode a confident not_question on a still-open question hides it ('dismissed') — but only
-- if the question did not grow since it was read (_seen_last): a follow-up the student added while the AI was deciding
-- is never hidden unseen (the row stays open and is re-triaged next run).
create or replace function public.question_triage_record(
  _id bigint, _verdict text, _kind text, _by text, _conf numeric, _reason text, _cost numeric, _seen_last timestamptz)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _live boolean := coalesce((select value->>'mode' from public.platform_settings where key = 'question_triage'), 'shadow') = 'live';
  _n int;
begin
  if coalesce(_verdict, '') not in ('question', 'not_question') or coalesce(_by, '') not in ('rule', 'ai', 'fallback') then
    raise exception 'question_triage_record: bad verdict/by';
  end if;
  update public.teacher_questions
     set triage = _verdict, triage_kind = left(_kind, 40), triage_by = _by, triage_conf = _conf,
         triage_reason = left(_reason, 200), triage_at = now(), triage_cost_usd = _cost, triage_lease_until = null
   where id = _id and triage is null
     and (_seen_last is null or last_msg_at is not distinct from _seen_last);
  get diagnostics _n = row_count;
  if _n = 0 then
    -- grew meanwhile (or already decided): release the lease so the next run reads the whole question
    update public.teacher_questions set triage_lease_until = null where id = _id and triage is null;
    return 'changed_or_gone';
  end if;
  if _live and _verdict = 'not_question' then
    update public.teacher_questions set status = 'dismissed' where id = _id and status = 'open';
    get diagnostics _n = row_count;
    if _n = 1 then return 'hidden'; end if;
  end if;
  return 'recorded';
end
$function$;

revoke execute on function public.question_triage_claim(int) from public, anon, authenticated;
revoke execute on function public.question_triage_record(bigint, text, text, text, numeric, text, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.question_triage_claim(int) to service_role;
grant execute on function public.question_triage_record(bigint, text, text, text, numeric, text, numeric, timestamptz) to service_role;

-- Open questions left untriaged > 15 min while triage is enabled → the admins (once a day per count).
create or replace function public.question_triage_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'question_triage'), '{}'::jsonb);
  _enabled boolean := coalesce(lower(_cfg->>'enabled'), 'true') <> 'false';
  _stuck int := 0;
  _today text := ((now() at time zone 'Asia/Tashkent')::date)::text;
  _hour int := extract(hour from now() at time zone 'Asia/Tashkent')::int;
  _prev jsonb := (select value from public.app_settings where key = 'question_triage_watchdog_state');
  _tok text; _admin record; _sent int := 0;
begin
  if _enabled then
    select count(*) into _stuck from public.teacher_questions
     where status = 'open' and triage is null and last_msg_at < now() - interval '15 minutes'
       and asked_at > now() - interval '24 hours';
  end if;
  if _stuck > 0 and _hour between 8 and 21 and coalesce(_prev->>'alerted_day', '') <> _today then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active' order by p.telegram_id
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text',
                              '⚠️ Savollar saralanmayapti: ' || _stuck || ' ta savol 15 daqiqadan beri tekshirilmagan '
                              || '(question-triage). Ular kuratorga savol sifatida koʻrinib turibdi — hech narsa yoʻqolmaydi. '
                              || 'Tekshirish: admin_actions (question_triage_*).'),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'question_triage_watchdog',
            p_timeout_ms := 5000);
          _sent := _sent + 1;
        exception when others then null; end;
      end loop;
    end if;
  end if;
  insert into public.app_settings (key, value)
  values ('question_triage_watchdog_state', jsonb_build_object('checked_at', now(), 'enabled', _enabled, 'stuck', _stuck,
          'alerted_day', case when _sent > 0 then to_jsonb(_today) else coalesce(_prev->'alerted_day', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('stuck', _stuck, 'alerted', _sent > 0);
end
$function$;

revoke execute on function public.question_triage_watchdog() from public, anon, authenticated;
grant execute on function public.question_triage_watchdog() to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('question-triage', 'question-triage-watchdog');
  perform cron.schedule('question-triage', '* * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/question-triage', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'question-triage', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'question_triage'), 'true') <> 'false'
     and exists (select 1 from public.teacher_questions q
                  where q.triage is null and (q.triage_lease_until is null or q.triage_lease_until < now())
                    and (q.asked_at > now() - interval '24 hours'
                         or q.asked_at >= coalesce((select case when coalesce(value->>'backfill_since', '') ~ '^\d{4}-\d{2}-\d{2}'
                                                                     then (value->>'backfill_since')::timestamptz end
                                                       from public.platform_settings where key = 'question_triage'),
                                                     'infinity'::timestamptz))) $cmd$);
  perform cron.schedule('question-triage-watchdog', '37 * * * *', $cmd$ select public.question_triage_watchdog() $cmd$);
end $$;

-- 3-GURUH: Barno covers; Feruza's co-curator link removed (recorded for restoring her).
do $$
declare _row record;
begin
  for _row in
    delete from public.group_teachers gt
     using public.groups g, public.profiles p
     where gt.group_id = g.id and g.name = 'AC CHALLENGE | 3-GURUH' and g.course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
       and gt.teacher_id = p.id and lower(p.telegram_username) = 'peluja_ai' and gt.is_primary = false
    returning gt.group_id, gt.teacher_id, gt.created_at
  loop
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'group_teacher_paused', jsonb_build_object(
      'group_id', _row.group_id, 'teacher_id', _row.teacher_id, 'group', 'AC CHALLENGE | 3-GURUH', 'teacher', 'Feruza (@peluja_ai)',
      'reason', 'away ~2 weeks; Barno covers', 'restore', 'insert into group_teachers (group_id, teacher_id, is_primary) values (group_id, teacher_id, false)',
      'migration', '20261016112600'));
  end loop;
end $$;
