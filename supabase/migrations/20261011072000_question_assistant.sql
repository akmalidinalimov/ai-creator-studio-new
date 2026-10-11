-- 🤖 Question assistant for «KURATORGA SAVOLLAR» (owner, 2026-10-11: "classify the technical questions and let the bot
-- answer them … check the user's account, find whether it is their account or a global platform problem, resolve it,
-- tell them it is solved; otherwise advise troubleshooting … like a customer-support employee").
--
-- Owner decisions (same day): answer IN THE TOPIC as «🤖 Yordamchi» with a «❌ Yordam bermadi» button that hands it back
-- to the curator · a 3-DAY TRIAL first (drafts go to the curator, who taps ✅ Yuborish / ❌ Kerak emas), then live ·
-- classify with the AI key we have now (Jev added later, side by side) · answer how-to questions ONLY from an
-- owner-approved knowledge base (support_kb), drafted from the curators' real answers.
--
-- MEASURED FIRST (14 days, the four Challenge question topics, 3,352 student messages): genuine PLATFORM problems are
-- rare (the only access refusals were 65 × module_locked; video_error 33 events in 7 days, mostly connectivity);
-- most "technical" questions are about the tools (Higgsfield / ChatGPT subscriptions, cards declined, a plan not
-- visible, where a link is) and course logistics.
--
-- PIPELINE (question-assistant edge function, pg_cron every minute while a question is waiting):
--   claim  question_assist_claim(): open questions quiet for settle_min (2) and not yet looked at
--   label  AI → category (platform_issue | tool_howto | course_logistics | learning | chatter) + kb_id + confidence
--   answer platform_issue → question_assist_platform_facts(): the student's account (found / linked / active /
--            enrolled / open modules) + their own errors in 24 h (module_locked, backend_unreachable, chunk_load,
--            render_crash, video_error) + the PLATFORM (distinct students with the same errors in 30 min) → a
--            concrete answer, a platform incident (admins alerted; every affected student told when it clears), or
--            troubleshooting steps;
--          tool_howto / course_logistics → the approved support_kb answer, verbatim; no match → the curator;
--          learning / chatter → the curator (chatter is not reminded about once live).
--   trial  mode 'shadow': a card to the group's curators with the draft — ✅ Yuborish posts it, ❌ Kerak emas drops it.
--   live   mode 'live': the reply goes into the topic at once; the question closes (answered_via 'assistant').
-- Every step is a row in question_assist (DB-visible); question_assistant_watchdog (:29) alerts on a stuck backlog,
-- failures or an exhausted AI budget. Kill-switch: platform_settings.question_assistant.enabled / .mode.

-- ── 1. config ────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.platform_settings (key, value, updated_at)
values ('question_assistant', jsonb_build_object(
  'enabled', true, 'mode', 'shadow', 'settle_min', 2, 'min_confidence', 0.7, 'chatter_min_confidence', 0.85,
  'ai_daily_budget_usd', 1, 'max_per_run', 8, 'global_users', 5, 'global_window_min', 30,
  'ai_provider_order', jsonb_build_array('openai', 'anthropic'),
  'trial_started_at', now()), now())
on conflict (key) do nothing;

-- ── 2. the knowledge base (answers the owner approved) ───────────────────────────────────────────────────────────
create table if not exists public.support_kb (
  id                text primary key,                      -- a slug
  category          text not null check (category in ('tool_howto', 'course_logistics', 'platform_usage', 'subscription_payment')),
  title_uz          text not null,
  example_questions text[] not null default '{}',
  answer_html       text not null,                         -- Telegram HTML, owner-approved, sent verbatim
  links             text[] not null default '{}',
  status            text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  volatile          boolean not null default false,        -- prices / plans / dates: re-check often
  approved_by       uuid,
  approved_at       timestamptz,
  updated_at        timestamptz not null default now()
);
alter table public.support_kb enable row level security;
revoke all on public.support_kb from anon, authenticated;

-- ── 3. what the assistant did with each question ─────────────────────────────────────────────────────────────────
create table if not exists public.question_assist (
  question_id      bigint primary key references public.teacher_questions(id) on delete cascade,
  status           text not null default 'working'
                   check (status in ('working', 'drafted', 'sent', 'approved', 'rejected', 'skipped', 'failed')),
  mode             text not null,
  category         text,
  platform_kind    text,
  kb_id            text references public.support_kb(id) on delete set null,
  confidence       numeric,
  diagnosis        jsonb,
  draft_html       text,
  provider         text,
  model            text,
  cost_usd         numeric not null default 0,
  error            text,
  curator_messages jsonb not null default '[]'::jsonb,     -- [{chat, msg}] the trial cards
  reply_message_id bigint,                                 -- the «🤖 Yordamchi» reply in the topic
  feedback         text check (feedback in ('not_helped')),
  incident_id      bigint,
  lease_until      timestamptz,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid
);
create index if not exists question_assist_status_idx on public.question_assist (status, created_at);
alter table public.question_assist enable row level security;
revoke all on public.question_assist from anon, authenticated;

-- a platform-wide problem the assistant told students about; when it clears they are told it is fixed
create table if not exists public.question_assist_incidents (
  id          bigserial primary key,
  kind        text not null,
  opened_at   timestamptz not null default now(),
  users_seen  int not null default 0,
  closed_at   timestamptz,
  notified    boolean not null default false
);
alter table public.question_assist_incidents enable row level security;
revoke all on public.question_assist_incidents from anon, authenticated;
revoke all on sequence public.question_assist_incidents_id_seq from anon, authenticated;

-- the assistant can close a question too
alter table public.teacher_questions drop constraint if exists teacher_questions_answered_via_check;
alter table public.teacher_questions add constraint teacher_questions_answered_via_check
  check (answered_via in ('group_reply', 'bot', 'manual', 'assistant'));

-- ── 4. claim ─────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.question_assist_claim(_settle_min int, _limit int, _mode text)
returns table (question_id bigint, group_id uuid, group_name text, chat_id bigint, thread_id bigint, tg_user_id bigint,
               student_id uuid, student_name text, text text, media jsonb, asked_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  -- a run that crashed: its rows are free again after the lease
  update public.question_assist a set status = 'failed', error = coalesce(a.error, 'lease expired')
   where a.status = 'working' and a.lease_until < now();

  return query
  with picked as (
    select q.id from public.teacher_questions q
     where q.status = 'open'
       and q.last_msg_at < now() - make_interval(mins => greatest(0, _settle_min))
       and q.asked_at > now() - interval '24 hours'
       and not exists (select 1 from public.question_assist a where a.question_id = q.id)
     order by q.asked_at
     limit greatest(1, least(_limit, 50))
     for update skip locked),
  ins as (
    insert into public.question_assist (question_id, mode, lease_until)
    select p.id, _mode, now() + interval '5 minutes' from picked p
    on conflict on constraint question_assist_pkey do nothing
    returning question_assist.question_id)
  select q.id, q.group_id, g.name, q.chat_id, q.thread_id, q.tg_user_id, q.student_id, q.student_name, q.text, q.media, q.asked_at
    from ins join public.teacher_questions q on q.id = ins.question_id join public.groups g on g.id = q.group_id;
end
$function$;

-- ── 5. platform facts for one question (no names, no message texts) ──────────────────────────────────────────────
create or replace function public.question_assist_platform_facts(_question bigint, _window_min int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  _q record;
  _p record;
  _course uuid;
  _limit int;
  _enrolled boolean := false;
  _total int;
begin
  select * into _q from public.teacher_questions where id = _question;
  if not found then return jsonb_build_object('found_question', false); end if;
  select p.id, p.status::text as status, p.archived_at, p.telegram_id, p.group_id into _p
    from public.profiles p
   where p.id = _q.student_id or (_q.student_id is null and p.telegram_id = _q.tg_user_id)
   order by (p.id = _q.student_id) desc nulls last limit 1;
  select g.course_id into _course from public.groups g where g.id = _q.group_id;
  if _p.id is not null then
    select true, ct.module_limit into _enrolled, _limit
      from public.enrollments e left join public.course_tiers ct on ct.id = e.tier_id
     where e.user_id = _p.id and e.course_id = _course limit 1;
  end if;
  select count(*) into _total from public.modules m where m.course_id = _course;

  return jsonb_build_object(
    'found_question', true,
    'account', jsonb_build_object(
      'found', _p.id is not null,
      'active', _p.id is not null and _p.status = 'active' and _p.archived_at is null,
      'telegram_linked', _p.telegram_id is not null,
      'in_this_group', _p.group_id = _q.group_id,
      'enrolled', coalesce(_enrolled, false),
      'open_modules', case when coalesce(_enrolled, false) then coalesce(_limit, _total) else 0 end,
      'total_modules', _total),
    'mine_24h', jsonb_build_object(
      'module_locked', (select count(*) from public.admin_actions a where a.action = 'video_access_denied'
                          and a.target_user_id = _p.id and a.created_at > now() - interval '24 hours'),
      'backend_unreachable', (select count(*) from public.client_error_events c where c.user_id = _p.id
                          and c.event_type = 'backend_unreachable' and c.created_at > now() - interval '24 hours'),
      'stale_app', (select count(*) from public.client_error_events c where c.user_id = _p.id
                          and c.event_type in ('chunk_load', 'render_crash') and c.created_at > now() - interval '24 hours'),
      'video_error', (select count(*) from public.client_error_events c where c.user_id = _p.id
                          and c.event_type = 'video_error' and c.created_at > now() - interval '24 hours')),
    'platform', jsonb_build_object(
      'video_error_users', (select count(distinct c.user_id) from public.client_error_events c
                             where c.event_type = 'video_error' and c.created_at > now() - make_interval(mins => _window_min)),
      'unreachable_users', (select count(distinct c.user_id) from public.client_error_events c
                             where c.event_type = 'backend_unreachable' and c.created_at > now() - make_interval(mins => _window_min)),
      'crash_users', (select count(distinct c.user_id) from public.client_error_events c
                       where c.event_type in ('chunk_load', 'render_crash') and c.created_at > now() - make_interval(mins => _window_min)),
      'open_incident', (select jsonb_build_object('id', i.id, 'kind', i.kind) from public.question_assist_incidents i
                         where i.closed_at is null order by i.opened_at desc limit 1)));
end
$function$;

revoke execute on function public.question_assist_claim(int, int, text) from public, anon, authenticated;
revoke execute on function public.question_assist_platform_facts(bigint, int) from public, anon, authenticated;
grant execute on function public.question_assist_claim(int, int, text) to service_role;
grant execute on function public.question_assist_platform_facts(bigint, int) to service_role;

-- ── 6. watchdog ──────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.question_assistant_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'question_assistant'), '{}'::jsonb);
  _enabled boolean := coalesce(lower(_cfg->>'enabled'), 'true') <> 'false';
  _prev jsonb := (select value from public.app_settings where key = 'question_assistant_watchdog_state');
  _backlog int; _failed int; _problems text[] := '{}'; _msg text; _tok text; _admin record; _alert boolean := false;
begin
  select count(*) into _backlog from public.teacher_questions q
   where q.status = 'open' and q.last_msg_at < now() - interval '15 minutes' and q.asked_at > now() - interval '24 hours'
     and not exists (select 1 from public.question_assist a where a.question_id = q.id);
  select count(*) into _failed from public.question_assist where status = 'failed' and created_at > now() - interval '1 hour';
  if _enabled and _backlog > 0 then _problems := array_append(_problems, _backlog || ' ta savol 15 daqiqadan beri koʻrilmagan'); end if;
  if _enabled and _failed > 2 then _problems := array_append(_problems, _failed || ' ta savolda xato (1 soat)'); end if;

  if cardinality(_problems) > 0
     and (_prev->>'last_alert_at' is null or (_prev->>'last_alert_at')::timestamptz < now() - interval '6 hours') then
    _msg := '⚠️ Savollar yordamchisi: ' || array_to_string(_problems, '; ')
            || E'\n\nTekshirish: question_assist, admin_actions (question_assistant_*).';
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
            p_purpose    := 'question_assistant_watchdog',
            p_timeout_ms := 5000);
          _alert := true;
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('question_assistant_watchdog_state', jsonb_build_object(
    'checked_at', now(), 'enabled', _enabled, 'backlog', _backlog, 'failed_1h', _failed, 'problems', to_jsonb(_problems),
    'last_alert_at', case when _alert then to_jsonb(now()) else coalesce(_prev->'last_alert_at', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('problems', to_jsonb(_problems), 'alerted', _alert);
end
$function$;

revoke execute on function public.question_assistant_watchdog() from public, anon, authenticated;
grant execute on function public.question_assistant_watchdog() to service_role;

-- ── 7. schedules ─────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('question-assistant', 'question-assistant-watchdog');
  perform cron.schedule('question-assistant', '* * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/question-assistant', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'question-assistant', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'question_assistant'), 'true') <> 'false'
     and (exists (select 1 from public.teacher_questions q
                   where q.status = 'open' and q.last_msg_at < now() - interval '2 minutes' and q.asked_at > now() - interval '24 hours'
                     and not exists (select 1 from public.question_assist a where a.question_id = q.id))
          or exists (select 1 from public.question_assist_incidents i where i.closed_at is null)) $cmd$);
  perform cron.schedule('question-assistant-watchdog', '29 * * * *', $cmd$ select public.question_assistant_watchdog() $cmd$);
end $$;
