-- «KURATORGA SAVOLLAR»: track every student question to the curator, remind the teacher after an hour, and give
-- teachers a ❓ Savollar inbox in the bot (owner, 2026-10-10: "it should be really easy for teachers to track which
-- questions are left unanswered, old or new").
--
-- MEASURED FIRST (webhook_inbox, 7 days, the four Challenge groups' question topics):
--  * ~26–32 questions a day per group (a student's consecutive messages within 10 min = one question; pure greetings /
--    thanks / emoji are not questions).
--  * Curators answer ANONYMOUSLY, as the group (from = GroupAnonymousBot 1087968824, sender_chat = the group itself):
--    760 of their messages a week, almost all Telegram REPLIES to the student. No earlier system recognised them —
--    every "question → teacher answer" signal looked for a teacher's own account (2 such messages all week).
--  * 45–63 % of questions got a curator reply (median 3–14 min); 54–133 a week per group got none.
--
-- MODEL — teacher_questions (one row per question):
--  * a student's message in the group's questions topic opens a question, or joins their open one if it is < merge_min
--    (10) minutes after their last message; a greeting / thanks / emoji-only message never opens one;
--  * a student's reply to a CLASSMATE's message is peer help (counted on that question as peer_reply_ids), not a question;
--  * ANSWERED when staff — the group posting anonymously, or any teacher/admin account — REPLIES to any message of the
--    question (answered_via 'group_reply'), when the teacher answers through the bot ('bot'), or taps ✅ ('manual');
--  * still open after expire_days (7) → 'expired' (it leaves the lists).
-- Built from webhook_inbox by teacher_questions_reconcile() (pg_cron, every minute, a cursor with a 2-minute overlap;
-- every step is idempotent) — the bot needs no change on its hot path to capture anything.
--
-- REMINDERS: the teacher-questions-reminder edge function (pg_cron every 5 min, only while something is due) DMs the
-- group's teachers ONE digest of the questions waiting > remind_after_min (60), then again every repeat_min (180), at
-- most max_reminders (3) times, never in quiet hours (23–08 Tashkent). A group with no reachable teacher → the admins.
--
-- HEALTH: app_settings.teacher_questions_state (the reconciler's heartbeat + counts); teacher_questions_watchdog()
-- (hourly :23) DMs the admins if the reconciler stopped or reminders are not delivered, and stamps
-- teacher_questions_watchdog_state (the GitHub verifier flags a stale one). Kill-switch:
-- platform_settings.teacher_questions.enabled. A group is tracked when groups.questions_thread_id is set.

-- ── 1. config + per-group topic ──────────────────────────────────────────────────────────────────────────────────
insert into public.platform_settings (key, value, updated_at)
values ('teacher_questions', jsonb_build_object(
  'enabled', true, 'merge_min', 10, 'new_min', 60, 'remind_after_min', 60, 'repeat_min', 180, 'max_reminders', 3,
  'expire_days', 7, 'quiet_start_hour', 23, 'quiet_end_hour', 8), now())
on conflict (key) do nothing;

alter table public.groups add column if not exists questions_thread_id bigint;
comment on column public.groups.questions_thread_id is
  'The forum topic (message_thread_id) where students ask the curator — tracked by teacher_questions_reconcile().';

-- The Challenge groups' question topics (thread ids from the topics'' forum_topic_created service messages).
update public.groups g set questions_thread_id = v.th
  from (values ('AC CHALLENGE | 1-GURUH', 2), ('AC CHALLENGE | 2-GURUH', 4),
               ('AC CHALLENGE | 3-GURUH', 3), ('AC CHALLENGE | 4-GURUH', 5)) v(name, th)
 where g.name = v.name and g.course_id = 'f502f631-2104-4834-b6c2-702cd3080e27' and g.questions_thread_id is null;

-- ── 2. the questions ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.teacher_questions (
  id                bigserial primary key,
  group_id          uuid not null references public.groups(id) on delete cascade,
  chat_id           bigint not null,
  thread_id         bigint not null,
  tg_user_id        bigint not null,
  student_id        uuid references public.profiles(id) on delete set null,
  student_name      text not null default '',
  student_username  text,
  first_message_id  bigint not null,
  message_ids       bigint[] not null default '{}',
  text              text not null default '',
  media             jsonb not null default '[]'::jsonb,           -- [{message_id, kind}]
  peer_reply_ids    bigint[] not null default '{}',
  asked_at          timestamptz not null,
  last_msg_at       timestamptz not null,
  status            text not null default 'open' check (status in ('open', 'answered', 'dismissed', 'expired')),
  answered_at       timestamptz,
  answered_by       uuid,
  answered_via      text check (answered_via in ('group_reply', 'bot', 'manual')),
  answer_message_id bigint,
  reminded_at       timestamptz,
  reminder_count    int not null default 0,
  created_at        timestamptz not null default now(),
  unique (chat_id, first_message_id)
);
create index if not exists teacher_questions_group_status_idx on public.teacher_questions (group_id, status, asked_at);
create index if not exists teacher_questions_open_idx on public.teacher_questions (asked_at) where status = 'open';
create index if not exists teacher_questions_msgs_idx on public.teacher_questions using gin (message_ids);
alter table public.teacher_questions enable row level security;   -- no policies: service role only (bot, edge, SQL)
revoke all on public.teacher_questions from anon, authenticated;
revoke all on sequence public.teacher_questions_id_seq from anon, authenticated;

-- ── 3. the reconciler ────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.teacher_questions_reconcile(_from timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'teacher_questions'), '{}'::jsonb);
  _merge interval;
  _expire interval;
  _state jsonb;
  _since timestamptz;
  _max timestamptz;
  _r record;
  _m jsonb;
  _mid bigint; _from_id bigint; _sender_chat bigint; _reply bigint; _reply_uid bigint;
  _staff uuid; _is_staff boolean; _txt text; _kind text; _ack boolean; _qid bigint; _k int;
  _scanned int := 0; _created int := 0; _appended int := 0; _answered int := 0; _peer int := 0; _expired int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('teacher_questions_reconcile')) then
    return jsonb_build_object('status', 'locked');
  end if;
  begin
    _merge  := make_interval(mins => greatest(1, least(120, coalesce((_cfg->>'merge_min')::int, 10))));
    _expire := make_interval(days => greatest(1, least(60, coalesce((_cfg->>'expire_days')::int, 7))));
  exception when others then
    _merge := interval '10 minutes'; _expire := interval '7 days';
  end;

  select value into _state from public.app_settings where key = 'teacher_questions_state';
  if coalesce((_cfg->>'enabled')::boolean, true) is not true then
    insert into public.app_settings (key, value)
    values ('teacher_questions_state', coalesce(_state, '{}'::jsonb) || jsonb_build_object('last_run', now(), 'status', 'disabled'))
    on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('status', 'disabled');
  end if;

  _since := coalesce(_from, (_state->>'cursor')::timestamptz - interval '2 minutes', now() - interval '10 minutes');
  _max := coalesce((_state->>'cursor')::timestamptz, _since);

  for _r in
    with qg as (
      select g.id as gid, g.questions_thread_id as th, public.group_telegram_chat_id(g.id) as chat
        from public.groups g where g.questions_thread_id is not null)
    select w.received_at, w.chat_id, qg.gid, qg.th, w.raw_update->'message' as m
      from public.webhook_inbox w
      join qg on qg.chat = w.chat_id and w.message_thread_id = qg.th
     where w.received_at > _since and w.received_at <= now() and w.raw_update ? 'message'
     order by w.received_at, w.id
     limit 3000
  loop
    _scanned := _scanned + 1;
    _max := greatest(_max, _r.received_at);
    _m := _r.m;
    continue when _m ?| array['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
                             'new_chat_members', 'left_chat_member', 'pinned_message'];
    _mid := (_m->>'message_id')::bigint;
    _from_id := nullif(_m #>> '{from,id}', '')::bigint;
    _sender_chat := nullif(_m #>> '{sender_chat,id}', '')::bigint;
    _reply := nullif(_m #>> '{reply_to_message,message_id}', '')::bigint;
    -- every post in a forum topic "replies" to the topic's creation message (id = the thread id): not a reply
    if _reply = _r.th or (_m->'reply_to_message') ? 'forum_topic_created' then _reply := null; end if;
    _reply_uid := nullif(_m #>> '{reply_to_message,from,id}', '')::bigint;

    _staff := null;
    if _from_id is not null and _from_id <> 1087968824 then
      select p.id into _staff from public.profiles p
       where p.telegram_id = _from_id
         and exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role in ('teacher', 'admin', 'superadmin'))
       limit 1;
    end if;
    -- the group posting anonymously (an admin with "remain anonymous") is the curator
    _is_staff := (_from_id = 1087968824 and _sender_chat = _r.chat_id) or _staff is not null;

    if _is_staff then
      if _reply is not null then
        update public.teacher_questions
           set status = 'answered', answered_at = _r.received_at, answered_by = _staff,
               answered_via = 'group_reply', answer_message_id = _mid
         where chat_id = _r.chat_id and thread_id = _r.th and _reply = any(message_ids) and status = 'open';
        get diagnostics _k = row_count;
        _answered := _answered + _k;
      end if;
      continue;
    end if;

    -- other bots, channels, anonymous senders of other chats: not students
    continue when _from_id is null or _from_id = 1087968824 or _sender_chat is not null
                  or coalesce((_m #>> '{from,is_bot}')::boolean, false);
    -- already taken (the 2-minute overlap re-reads messages)
    continue when exists (select 1 from public.teacher_questions q
                           where q.chat_id = _r.chat_id and q.thread_id = _r.th and _mid = any(q.message_ids));

    -- a reply to a CLASSMATE's message: peer help on that question, not a new one
    if _reply is not null and _reply_uid is not null and _reply_uid <> _from_id and _reply_uid <> 1087968824
       and not exists (select 1 from public.profiles p join public.user_roles ur on ur.user_id = p.id
                        where p.telegram_id = _reply_uid and ur.role in ('teacher', 'admin', 'superadmin')) then
      update public.teacher_questions
         set peer_reply_ids = peer_reply_ids || _mid
       where chat_id = _r.chat_id and thread_id = _r.th and _reply = any(message_ids) and status = 'open'
         and not (_mid = any(peer_reply_ids));
      get diagnostics _k = row_count;
      _peer := _peer + _k;
      continue;
    end if;

    _txt := btrim(coalesce(_m->>'text', _m->>'caption', ''));
    _kind := case when _m ? 'photo' then 'photo' when _m ? 'video' then 'video' when _m ? 'document' then 'document'
                  when _m ? 'voice' then 'voice' when _m ? 'video_note' then 'video_note' when _m ? 'audio' then 'audio' end;
    continue when _txt = '' and _kind is null;          -- stickers, polls, …
    _ack := _kind is null and (
      _txt !~ '[[:alnum:]]'
      or lower(_txt) ~ ('^\s*(assalomu?\s*a[ly]a?[iy]?kum|assalamu?\s*a[ly]a?[iy]?kum|salom|rahmat|raxmat|katta\s+rahmat|'
                        || 'tushundim|tushunarli|ok|okay|xop|xo''p|ha|xa|yaxshi|zo''r|zor|ассалому?\s*ал[ае]йкум|салом|'
                        || 'рахмат|раҳмат|тушундим|хоп|ха|спасибо|спс|понятно|ок)[\s!.,)]*[^[:alnum:]]*$'));

    -- the same student's open question, still being typed → join it
    select q.id into _qid from public.teacher_questions q
     where q.chat_id = _r.chat_id and q.thread_id = _r.th and q.tg_user_id = _from_id and q.status = 'open'
       and q.last_msg_at >= _r.received_at - _merge
     order by q.last_msg_at desc limit 1;
    if _qid is not null then
      update public.teacher_questions
         set message_ids = message_ids || _mid,
             text = left(case when text = '' then _txt when _txt = '' then text else text || E'\n' || _txt end, 3000),
             media = case when _kind is null then media
                          else media || jsonb_build_array(jsonb_build_object('message_id', _mid, 'kind', _kind)) end,
             last_msg_at = greatest(last_msg_at, _r.received_at)
       where id = _qid;
      _appended := _appended + 1;
      continue;
    end if;
    continue when _ack;                                   -- a greeting / thanks on its own is not a question

    insert into public.teacher_questions (group_id, chat_id, thread_id, tg_user_id, student_id, student_name,
                                          student_username, first_message_id, message_ids, text, media, asked_at, last_msg_at)
    values (_r.gid, _r.chat_id, _r.th, _from_id,
            (select p.id from public.profiles p where p.telegram_id = _from_id
              order by (p.group_id = _r.gid) desc nulls last, p.created_at limit 1),
            left(btrim(coalesce(_m #>> '{from,first_name}', '') || ' ' || coalesce(_m #>> '{from,last_name}', '')), 120),
            nullif(_m #>> '{from,username}', ''),
            _mid, array[_mid], left(_txt, 3000),
            case when _kind is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('message_id', _mid, 'kind', _kind)) end,
            _r.received_at, _r.received_at)
    on conflict (chat_id, first_message_id) do nothing;
    get diagnostics _k = row_count;
    _created := _created + _k;
  end loop;

  update public.teacher_questions set status = 'expired' where status = 'open' and asked_at < now() - _expire;
  get diagnostics _expired = row_count;

  insert into public.app_settings (key, value)
  values ('teacher_questions_state', jsonb_build_object(
    'cursor', _max, 'last_run', now(), 'status', 'ok', 'scanned', _scanned, 'created', _created, 'appended', _appended,
    'answered', _answered, 'peer', _peer, 'expired', _expired,
    'open', (select count(*) from public.teacher_questions where status = 'open'),
    'groups', (select count(*) from public.groups where questions_thread_id is not null)))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('status', 'ok', 'scanned', _scanned, 'created', _created, 'appended', _appended,
                            'answered', _answered, 'peer', _peer, 'expired', _expired);
end
$function$;

revoke execute on function public.teacher_questions_reconcile(timestamptz) from public, anon, authenticated;
grant execute on function public.teacher_questions_reconcile(timestamptz) to service_role;

-- ── 3b. reminder claims (teacher-questions-reminder) ──────────────────────────────────────────────────────────────
-- Claim the due questions BEFORE the digest goes out (reminded_at + reminder_count, FOR UPDATE SKIP LOCKED): two
-- overlapping runs never send the same question twice. A question no recipient received is un-claimed again.
create or replace function public.teacher_questions_claim_reminders(_after_min int, _repeat_min int, _max int, _limit int default 200)
returns setof public.teacher_questions
language sql
security definer
set search_path to 'public'
as $function$
  update public.teacher_questions t
     set reminded_at = now(), reminder_count = t.reminder_count + 1
   where t.id in (
     select q.id from public.teacher_questions q
      where q.status = 'open'
        and q.asked_at < now() - make_interval(mins => greatest(1, _after_min))
        and q.reminder_count < _max
        and (q.reminded_at is null or q.reminded_at < now() - make_interval(mins => greatest(1, _repeat_min)))
      order by q.asked_at
      limit greatest(1, least(_limit, 500))
      for update skip locked)
  returning t.*;
$function$;

create or replace function public.teacher_questions_unclaim_reminders(_ids bigint[])
returns int
language sql
security definer
set search_path to 'public'
as $function$
  with u as (
    update public.teacher_questions
       set reminder_count = greatest(reminder_count - 1, 0), reminded_at = null
     where id = any(_ids) and status = 'open'
    returning 1)
  select count(*)::int from u;
$function$;

revoke execute on function public.teacher_questions_claim_reminders(int, int, int, int) from public, anon, authenticated;
revoke execute on function public.teacher_questions_unclaim_reminders(bigint[]) from public, anon, authenticated;
grant execute on function public.teacher_questions_claim_reminders(int, int, int, int) to service_role;
grant execute on function public.teacher_questions_unclaim_reminders(bigint[]) to service_role;

-- ── 4. the watchdog ──────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.teacher_questions_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'teacher_questions'), '{}'::jsonb);
  _enabled boolean := coalesce((_cfg->>'enabled')::boolean, true);
  _st jsonb := (select value from public.app_settings where key = 'teacher_questions_state');
  _prev jsonb := (select value from public.app_settings where key = 'teacher_questions_watchdog_state');
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _stale boolean;
  _undelivered int;
  _overdue int;
  _problems text[] := '{}';
  _msg text;
  _tok text;
  _admin record;
  _alert boolean := false;
begin
  _stale := _enabled and coalesce((_st->>'last_run')::timestamptz < now() - interval '15 minutes', true);
  select count(*) into _undelivered from public.admin_actions
   where action in ('teacher_question_reminder_undelivered', 'teacher_question_answer_failed', 'teacher_questions_reminder_run')
     and created_at > now() - interval '1 hour'
     and (action <> 'teacher_questions_reminder_run' or details->>'status' = 'crashed');
  -- waiting > 4 h in the daytime and never reminded: the reminder leg is not working
  select count(*) into _overdue from public.teacher_questions
   where status = 'open' and reminder_count = 0 and asked_at < now() - interval '4 hours';

  if _stale then _problems := array_append(_problems, 'savollar yigʻilmayapti (reconcile toʻxtagan)'); end if;
  if _undelivered > 0 then _problems := array_append(_problems, _undelivered || ' ta eslatma/javob yetkazilmadi (1 soat)'); end if;
  if _overdue > 0 and _hour between 9 and 21 then _problems := array_append(_problems, _overdue || ' ta savol 4 soatdan beri eslatmasiz'); end if;

  if _enabled and cardinality(_problems) > 0
     and (_prev->>'last_alert_at' is null or (_prev->>'last_alert_at')::timestamptz < now() - interval '6 hours') then
    _msg := '⚠️ Kuratorga savollar: ' || array_to_string(_problems, '; ')
            || E'\n\nTekshirish: app_settings.teacher_questions_state, admin_actions (teacher_question_*).';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active' limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'teacher_questions_watchdog',
            p_timeout_ms := 5000);
          _alert := true;
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('teacher_questions_watchdog_state', jsonb_build_object(
    'checked_at', now(), 'enabled', _enabled, 'stale', _stale, 'undelivered_1h', _undelivered, 'overdue_unreminded', _overdue,
    'problems', to_jsonb(_problems),
    'last_alert_at', case when _alert then to_jsonb(now()) else coalesce(_prev->'last_alert_at', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('problems', to_jsonb(_problems), 'alerted', _alert);
end
$function$;

revoke execute on function public.teacher_questions_watchdog() from public, anon, authenticated;
grant execute on function public.teacher_questions_watchdog() to service_role;

-- ── 5. schedules ─────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('teacher-questions-reconcile', 'teacher-questions-reminder', 'teacher-questions-watchdog');

  perform cron.schedule('teacher-questions-reconcile', '* * * * *', $cmd$ select public.teacher_questions_reconcile() $cmd$);

  perform cron.schedule('teacher-questions-reminder', '*/5 * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/teacher-questions-reminder', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'teacher-questions-reminder', 60000)
   where coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'teacher_questions'), true)
     and exists (
       select 1 from public.teacher_questions q
        where q.status = 'open'
          and q.asked_at < now() - make_interval(mins => coalesce(
                (select (value->>'remind_after_min')::int from public.platform_settings where key = 'teacher_questions'), 60))
          and q.reminder_count < coalesce(
                (select (value->>'max_reminders')::int from public.platform_settings where key = 'teacher_questions'), 3)
          and (q.reminded_at is null or q.reminded_at < now() - make_interval(mins => coalesce(
                (select (value->>'repeat_min')::int from public.platform_settings where key = 'teacher_questions'), 180)))) $cmd$);

  perform cron.schedule('teacher-questions-watchdog', '23 * * * *', $cmd$ select public.teacher_questions_watchdog() $cmd$);
end $$;

-- ── 6. backfill the last 12 hours, so the inbox starts with today's open questions ──────────────────────────────
-- (a deliberate first run, not a self-test: it writes question rows and the cursor, exactly as the cron would)
select public.teacher_questions_reconcile(now() - interval '12 hours');

do $test$
declare _st jsonb := (select value from public.app_settings where key = 'teacher_questions_state');
begin
  if _st is null or _st->>'status' <> 'ok' then raise exception 'selftest: reconcile did not run (%)', _st; end if;
  if (select count(*) from public.groups where questions_thread_id is not null) < 4 then
    raise exception 'selftest: the four Challenge question topics are not set';
  end if;
  raise notice 'teacher questions after the 12 h backfill: %', _st;
end
$test$;
