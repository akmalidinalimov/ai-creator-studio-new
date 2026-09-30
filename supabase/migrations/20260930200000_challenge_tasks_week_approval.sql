-- Challenge 6.0 daily tasks, PR-9: the WEEKLY TELEGRAM APPROVAL of next week's tasks. INERT at merge: the new tick
-- runs only while platform_settings.challenge_tasks is ACTIVE (enabled = false today -> a heartbeat stamp only). Go-live
-- is PR-8; from then on nothing extra is needed.
--
-- ═══ THE OWNER'S PLAN (verbatim intent) ═══
-- Every task sits in the calendar as a DRAFT (a draft is never posted). Every week the bot DMs the admins, on Thursday
-- 12:00: «Keyingi hafta vazifalari (5–9 oktabr)» -- each day's weekday + date, title, type, points and what a student
-- must submit -- with [✅ Haftani tasdiqlash] (approves every draft of the week in one tap, WITH a confirm step) and
-- [👀 Ko‘rib chiqish] (the admin calendar on that week). Not approved yet -> a reminder on Saturday and Sunday at 19:00.
-- A day still unapproved at post time posts nothing and alerts the admins (#243). Only admins get the message and can
-- press the buttons (checked on the server, refused for anyone else and while impersonating); every approval is
-- recorded.
--
-- ═══ WHAT THIS DOES ═══
-- 1. platform_settings.challenge_tasks.approval = {enabled, ask_dow, ask_time, remind_dows, remind_time}, seeded with a
--    jsonb MERGE that keeps every other key and only when the key is absent (an owner's edit is never overwritten).
--    challenge_task_approval_parse() (IMMUTABLE): absent / JSON null = the defaults silently; present but malformed =
--    the default AND listed in invalid[] (-> 'challenge_week_approval_config_invalid', once a day).
-- 2. Ledger: challenge_task_week_approvals (one row per target week: asked_at, reminded_on[], no_tasks_at, approved_at,
--    approved_by, last_result) + challenge_task_week_approval_messages (one row per admin per ask / reminder / note:
--    the send state machine pending|sending|sent|failed|skipped, and the Telegram message_id that later edits use).
--    RLS on, admins read; written only by the SECURITY DEFINER functions below (service_role for the worker).
-- 3. challenge_tasks_week_approval_tick(_at) -- cron 'challenge-tasks-week-approval' every 5 minutes. Target week = the
--    Monday..Sunday that starts NEXT Monday (Tashkent). From ask_dow/ask_time (Thursday 12:00) until the week starts,
--    outside quiet hours:
--      ask      the week has >= 1 DRAFT (challenge courses, inside the window) and no ask went out yet -> one DM per
--               admin NOW (so a go-live after Thursday 12:00 asks at once);
--      remind   on remind_dows (Sat, Sun) from remind_time (19:00), drafts remain, the ask went out on an EARLIER day,
--               not reminded today -> one reminder;
--      no_tasks the week has no live task at all while it has configured task days inside the window -> one
--               «keyingi haftaga vazifa yo‘q» note.
--    It only DECIDES and ENQUEUES, then kicks challenge-tasks-worker {mode: 'week_approval'} (ops_net_post), which
--    renders (supabase/functions/_shared/week-approval.ts) and sends through sendTelegramWithResult and records every
--    outcome (challenge_task_week_msg_claim / _record). Heartbeat: app_settings 'challenge_tasks_week_approval_state'.
-- 4. challenge_tasks_approve_week(_week_start, _actor default null, _course_id default null): service_role -> _actor
--    required and must be an admin (the bot passes the REAL clicker); authenticated -> the actor is auth.uid() and must
--    be an admin (the web button); anon / anything else refused. Approves every status='draft' task of that Monday..Sunday
--    of the challenge course(s) ONE BY ONE through the existing trg_challenge_tasks_guard (scope, window, requires, post
--    length; it stamps approved_by := auth.uid()) -- the service-role path sets request.jwt.claims (and the legacy
--    request.jwt.claim.sub) LOCALLY to the actor for the loop and restores them after, so approved_by is the real admin.
--    Per-row exception capture: {approved, already_approved, failed:[{date,title,error}], drafts_left}. Serialized per
--    week (advisory lock): a double tap / a second admin gets approved 0 + already_approved N. Audit:
--    admin_actions 'challenge_week_approved' (actor, via, week, counts, failures) on every call.
-- 5. challenge_task_week_view(week, course) (service_role): the week as the renderer needs it (tasks with points from
--    challenge_task_post_context -- the SAME numbers the post shows --, requires, the configured days with no task,
--    counts, ledger). challenge_task_week_edits_record(): the bot records the edits of the other admins' copies.
-- 6. challenge_task_week_approval_health(_at) (read-only) + ONE pinned rewrite of challenge_tasks_watchdog (live md5
--    ab091a8a..., = PR-5's rewritten body): 'week_approval_undelivered' (the ask has been due for > 2 h of non-quiet
--    time and no ask / reminder reached any admin, drafts remain) and 'week_approval_silent' (the approval tick's
--    heartbeat is older than 20 minutes). Same 24-h dedupe and SQL->pg_net admin DMs as every other alarm there --
--    independent of this tick AND of the edge worker it watches.
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * challenge_tasks has 0 rows; triggers on it: trg_challenge_tasks_guard (v1, BEFORE INSERT/UPDATE) and
--   trg_challenge_tasks_zz_lock (v2, BEFORE UPDATE; a draft with no post / live submission passes untouched). Neither
--   reacts to request.jwt.claims except through auth.uid() (the guard's approved_by / created_by stamps; the lock's
--   audit row only on a cancel transition).
-- * auth.uid() = coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (claims->>'sub'))::uuid;
--   auth.role() = the same over claim.role / claims->>'role'. has_role(uuid, app_role) = an EXACT role row.
-- * Admins: 2 profiles with role 'admin' and a telegram_id (no superadmin rows exist). The bot's getPersona() says
--   "admin" only for role 'admin', so the recipients are role 'admin' (deviation d2).
-- * challenge_tasks_watchdog md5(replace(prosrc, E'\r', '')) = ab091a8a4dfba493296490c558d6d198 (PR-5's _new_pin).
-- * platform_settings: no trigger; challenge.enabled = true, window.start 2026-10-01T00:00+05; challenge_tasks has no
--   'approval' key. Six daily-topic groups, all course f502f631 (AI CREATORS CHALLENGE 6.0), none a test group.
--
-- ═══ DEVIATIONS FROM THE PLAN (each argued; the PR body repeats them) ═══
-- d1 Gate = challenge_tasks_config().active (enabled AND challenge.enabled AND a parseable window) AND approval.enabled,
--    not enabled alone: the same switch as every other daily-task leg, so the watchdog that checks delivery (active-only)
--    is always running while asks are. challenge.enabled is true live, so today active == challenge_tasks.enabled.
-- d2 Recipients: role 'admin' with a telegram_id (not archived), deterministic order, capped at 5 -- the set the bot will
--    let press the buttons. challenge_tasks_admin_dm's set is admin|superadmin LIMIT 3 in no order; live both are the same
--    two people, and a superadmin-only account would receive buttons that refuse it.
-- d3 One ledger row per WEEK (course_ids[] inside), not per course: the button approves the week for the challenge
--    course(s); live there is one. The web button passes _course_id (the page's course) -- an extra optional argument.
-- d4 The "no tasks" note goes out at the ask moment, or at go-live when that is later (like the ask), once per week.
-- d5 No SQL fallback sender for the ask: an undelivered ask is an alarm (the watchdog DMs admins through pg_net with
--    the calendar link, where the same approval is one button), not a second sender with its own message ids to edit.
-- d6 Cron every 5 minutes (not every minute): an ask at 12:00-12:05 is on time; the heartbeat threshold is 20 minutes.
-- d7 A web approval does not edit the Telegram copies (the web has no sender); a later tap on a stale copy answers
--    «allaqachon tasdiqlangan» and edits that copy to the result.
--
-- ═══ KILL-SWITCHES ═══
-- platform_settings.challenge_tasks.approval.enabled = false (asks / reminders / notes stop; the web button still works);
-- challenge_tasks.enabled = false stops everything. Last resort: cron.unschedule('challenge-tasks-week-approval') -- the
-- watchdog then alarms 'week_approval_silent' while active (that is the point).
--
-- ═══ DETECTION (graceful is not silent) ═══
-- admin_actions 'challenge_week_approval_asked' / '_reminded' / '_no_tasks' / '_undelivered' (every admin's send failed,
-- or no admin has a telegram_id) / 'challenge_week_approved' / 'challenge_week_approval_copies_updated' /
-- 'challenge_week_approval_tick_failed' (once a day per failing section) / 'challenge_week_approval_config_invalid';
-- the worker's 'challenge_task_worker_run' {mode: week_approval}; the bot's 'challenge_week_approval_refused' /
-- 'challenge_week_approval_failed'; health + the two watchdog alarms above.
--
-- SELF-TEST: non-mutating only -- parser + week-plan fixtures (pure), catalog / RLS / ACL / cron / the watchdog rewrite,
-- and read-only calls of the view and the health (shape). It never calls the tick, the approve RPC (it would need a JWT
-- AND would approve), a claim or a record, and never sends.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-week-approval-check.ts (#218 + PR-1 + PR-2 + PR-3 +
-- PR-5 + THIS file; the tick on a pinned clock, the RPC under real JWT claims, the worker's week_approval run and the
-- bot's dtw: callbacks end to end with a fake Telegram).
-- Merge: after PR-5 (20260930152010, ledgered). Label migration-approved, NEVER ops-agent. One migration PR at a time.

-- ═══════════════════════════════ 0. Prerequisites: PR-2 (guard), PR-3 (engine), PR-5 (tick / watchdog), the wrappers ═══════════════════════════════
do $$
begin
  if to_regprocedure('public.challenge_tasks_config()') is null
     or to_regprocedure('public.challenge_task_topics()') is null
     or to_regprocedure('public.challenge_task_post_context(public.challenge_tasks)') is null
     or to_regprocedure('public.challenge_task_local_date(timestamptz)') is null
     or to_regprocedure('public.challenge_tasks_watchdog(timestamptz)') is null
     or to_regprocedure('public.challenge_tasks_tick()') is null
     or to_regprocedure('public.has_role(uuid, public.app_role)') is null
     or not exists (select 1 from pg_trigger where tgrelid = 'public.challenge_tasks'::regclass
                     and tgname = 'trg_challenge_tasks_guard' and not tgisinternal) then
    raise exception 'ABORT: Daily Tasks PR-2 / PR-3 / PR-5 (20260930122010, 20260930150020, 20260930152010) must be applied first';
  end if;
  if to_regprocedure('public.ops_net_post(text, jsonb, jsonb, text, integer)') is null
     or to_regprocedure('public.cron_service_key()') is null or to_regprocedure('public.internal_fn_secret()') is null then
    raise exception 'ABORT: ops_net_post / cron_service_key / internal_fn_secret missing';
  end if;
end $$;

-- ═══════════════════════════════ 1. Pure helpers (self-tested on fixtures) ═══════════════════════════════
create or replace function public.challenge_task_approval_parse(_a jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
-- platform_settings.challenge_tasks.approval -> {enabled, ask_dow (ISO 1..7), ask_time 'HH:MM', remind_dows [ISO 1..7],
-- remind_time 'HH:MM', invalid[]}. ABSENT or JSON null = the default, silently; PRESENT but malformed = the default AND
-- its name in invalid[]. Never raises (a bad setting must never stop the tick).
declare
  _o jsonb := jsonb_build_object('enabled', true, 'ask_dow', 4, 'ask_time', '12:00', 'remind_dows', '[6,7]'::jsonb,
                                 'remind_time', '19:00');
  _inv text[] := '{}';
  _k text;
  _days int[];
begin
  if _a is null or jsonb_typeof(_a) = 'null' then
    return _o || jsonb_build_object('invalid', '[]'::jsonb);
  end if;
  if jsonb_typeof(_a) <> 'object' then
    return _o || jsonb_build_object('invalid', '["approval"]'::jsonb);
  end if;
  if _a ? 'enabled' and jsonb_typeof(_a->'enabled') <> 'null' then
    if jsonb_typeof(_a->'enabled') = 'boolean' then
      _o := _o || jsonb_build_object('enabled', _a->'enabled');
    else
      _inv := _inv || 'approval.enabled'::text;
    end if;
  end if;
  if _a ? 'ask_dow' and jsonb_typeof(_a->'ask_dow') <> 'null' then
    if jsonb_typeof(_a->'ask_dow') = 'number' and (_a->>'ask_dow') ~ '^[1-7]$' then
      _o := _o || jsonb_build_object('ask_dow', (_a->>'ask_dow')::int);
    else
      _inv := _inv || 'approval.ask_dow'::text;
    end if;
  end if;
  foreach _k in array array['ask_time', 'remind_time'] loop
    if _a ? _k and jsonb_typeof(_a->_k) <> 'null' then
      if jsonb_typeof(_a->_k) = 'string' and (_a->>_k) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        _o := _o || jsonb_build_object(_k, _a->>_k);
      else
        _inv := _inv || ('approval.' || _k);
      end if;
    end if;
  end loop;
  if _a ? 'remind_dows' and jsonb_typeof(_a->'remind_dows') <> 'null' then
    if jsonb_typeof(_a->'remind_dows') = 'array'
       and not exists (select 1 from jsonb_array_elements(_a->'remind_dows') x
                        where jsonb_typeof(x) <> 'number' or (x #>> '{}') !~ '^[1-7]$') then
      select coalesce(array_agg(distinct (x #>> '{}')::int order by (x #>> '{}')::int), '{}') into _days
        from jsonb_array_elements(_a->'remind_dows') x;
      _o := _o || jsonb_build_object('remind_dows', to_jsonb(_days));
    else
      _inv := _inv || 'approval.remind_dows'::text;
    end if;
  end if;
  return _o || jsonb_build_object('invalid', to_jsonb(_inv));
exception when others then
  return jsonb_build_object('enabled', true, 'ask_dow', 4, 'ask_time', '12:00', 'remind_dows', '[6,7]'::jsonb,
                            'remind_time', '19:00', 'invalid', '["approval"]'::jsonb);
end
$fn$;

create or replace function public.challenge_task_week_plan(_at timestamptz, _ap jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $fn$
  -- The approval target at _at (Tashkent): week_start = the Monday strictly AFTER today (on a Monday: next week's);
  -- ask_at = ask_dow at ask_time of the week before it (Thursday 12:00 -> 4 days before); week_ts = its Monday 00:00.
  with d as (select (_at at time zone 'Asia/Tashkent')::date as today),
       w as (select d.today, d.today + (8 - extract(isodow from d.today)::int) as ws from d)
  select jsonb_build_object(
    'today', w.today,
    'week_start', w.ws,
    'week_end', w.ws + 6,
    'week_ts', (w.ws::timestamp at time zone 'Asia/Tashkent'),
    'ask_at', (((w.ws - (8 - coalesce((_ap->>'ask_dow')::int, 4))) + coalesce((_ap->>'ask_time')::time, time '12:00'))::timestamp
                 at time zone 'Asia/Tashkent'))
    from w
$fn$;

create or replace function public.challenge_task_in_quiet(_t time, _qs time, _qe time)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  -- the tick's / the outbox claim's quiet-hours rule (a window may cross midnight)
  select coalesce((_qs > _qe and (_t >= _qs or _t < _qe)) or (_qs < _qe and _t >= _qs and _t < _qe), false)
$fn$;

-- ═══════════════════════════════ 2. The ledger ═══════════════════════════════
create table if not exists public.challenge_task_week_approvals (
  week_start date primary key check (extract(isodow from week_start) = 1),
  course_ids uuid[] not null default '{}',
  asked_at timestamptz,            -- the ask was queued (first time)
  reminded_on date[] not null default '{}',
  no_tasks_at timestamptz,         -- the "no task next week" note was queued
  approved_at timestamptz,         -- the last week approval that approved something
  approved_by uuid,
  last_result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.challenge_task_week_approval_messages (
  id bigint generated always as identity primary key,
  week_start date not null references public.challenge_task_week_approvals(week_start) on delete cascade,
  kind text not null check (kind in ('ask', 'remind', 'no_tasks')),
  sent_on date not null,           -- the Tashkent date it was queued (one per admin per kind per day)
  user_id uuid not null references public.profiles(id) on delete cascade,
  chat_id bigint not null,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  terminal boolean not null default false,
  attempts integer not null default 0 check (attempts >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  message_id bigint,
  error text,
  sent_at timestamptz,
  edited_at timestamptz,           -- the copy was edited to the approval result
  edit_error text,
  created_at timestamptz not null default now(),
  constraint challenge_task_week_msg_sent_has_id check (state <> 'sent' or message_id is not null),
  unique (week_start, kind, sent_on, user_id)
);
create index if not exists idx_ctask_week_msg_open on public.challenge_task_week_approval_messages (state)
  where state in ('pending', 'sending', 'failed');

comment on table public.challenge_task_week_approvals is
  'Daily Tasks PR-9: one row per target week of the weekly Telegram approval (asked / reminded / approved). Written only by '
  'challenge_tasks_week_approval_tick() and challenge_tasks_approve_week().';
comment on table public.challenge_task_week_approval_messages is
  'Daily Tasks PR-9: one row per admin per ask / reminder / note: the send state (challenge-tasks-worker) and the Telegram '
  'message_id the bot edits after an approval.';

-- ═══════════════════════════════ 3. Scope, recipients, counts, the view ═══════════════════════════════
create or replace function public.challenge_task_week_courses()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $fn$
  -- the courses the weekly approval covers: every course with a non-test daily-task topic (the courses the tick posts
  -- for; test-only E2E courses never ask admins)
  select coalesce(array_agg(x.course_id order by x.course_id), '{}')
    from (select g.course_id from public.challenge_task_topics() g
           where g.course_id is not null group by g.course_id having bool_or(not g.is_test)) x
$fn$;

create or replace function public.challenge_task_week_recipients()
returns table (user_id uuid, telegram_id bigint, name text)
language sql
stable
security definer
set search_path = public
as $fn$
  -- d2: role 'admin' (= who the bot lets press the buttons) with a telegram_id, not archived; capped at 5
  select p.id, p.telegram_id, p.name::text
    from public.profiles p
   where p.telegram_id is not null and p.archived_at is null
     and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'::public.app_role)
   order by p.id
   limit 5
$fn$;

create or replace function public.challenge_task_week_counts(_week date, _cfg jsonb default null, _course uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  -- drafts = DRAFT tasks of the week inside the challenge window dates (what an ask is about); live = every non-cancelled
  -- task; configured_days = task weekdays of the week inside the window (the "no task" note needs >= 1)
  with c as (select coalesce(_cfg, public.challenge_tasks_config()) as cfg),
       cs as (select case when _course is not null then array[_course] else public.challenge_task_week_courses() end as ids),
       t as (select t.task_date, t.status from public.challenge_tasks t, cs
              where t.course_id = any(cs.ids) and t.task_date between _week and _week + 6 and t.status <> 'cancelled'),
       win as (select t.* from t, c
                where ((c.cfg->>'w_start_date') is null or t.task_date >= (c.cfg->>'w_start_date')::date)
                  and ((c.cfg->>'w_end_date') is null or t.task_date <= (c.cfg->>'w_end_date')::date))
  select jsonb_build_object(
    'drafts', (select count(*)::int from win where win.status = 'draft'),
    'drafts_all', (select count(*)::int from t where t.status = 'draft'),
    'approved', (select count(*)::int from t where t.status = 'approved'),
    'live', (select count(*)::int from t),
    'configured_days', (select count(*)::int from generate_series(0, 6) i, c
                         where extract(isodow from _week + i)::int in
                                 (select (x #>> '{}')::int
                                    from jsonb_array_elements(coalesce(c.cfg->'task_weekdays', '[1,2,3,4,5]'::jsonb)) x)
                           and ((c.cfg->>'w_start_date') is null or _week + i >= (c.cfg->>'w_start_date')::date)
                           and ((c.cfg->>'w_end_date') is null or _week + i <= (c.cfg->>'w_end_date')::date)),
    'course_ids', (select to_jsonb(cs.ids) from cs))
$fn$;

create or replace function public.challenge_task_week_view(_week_start date, _course_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- Everything the ask / confirm / result messages render (supabase/functions/_shared/week-approval.ts). Points come from
-- challenge_task_post_context -- the SAME numbers the 09:00 post will show. missing = configured task days inside the
-- window with no live task (for some course of the scope). Read-only.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _courses uuid[];
  _tasks jsonb;
  _missing jsonb;
  _l record;
begin
  if _week_start is null or extract(isodow from _week_start) <> 1 then
    raise exception using errcode = '22023', message = 'challenge_task_week_view: _week_start must be a Monday';
  end if;
  _courses := case when _course_id is not null then array[_course_id] else public.challenge_task_week_courses() end;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'course_id', t.course_id, 'course_title', c.title, 'date', t.task_date,
           'weekday', extract(isodow from t.task_date)::int, 'type', t.type, 'title', t.title, 'status', t.status,
           'points', ctx.points, 'requires', t.requires, 'accepts', to_jsonb(t.accepts), 'min_text_chars', t.min_text_chars,
           'min_duration_sec', t.min_duration_sec)
           order by t.task_date, c.title, t.id), '[]'::jsonb)
    into _tasks
    from public.challenge_tasks t
    left join public.courses c on c.id = t.course_id
    cross join lateral public.challenge_task_post_context(t) ctx
   where t.course_id = any(_courses) and t.task_date between _week_start and _week_start + 6 and t.status <> 'cancelled';
  select coalesce(jsonb_agg(to_jsonb(d.d) order by d.d), '[]'::jsonb) into _missing
    from (select _week_start + i as d from generate_series(0, 6) i) d
   where extract(isodow from d.d)::int in (select (x #>> '{}')::int
                                             from jsonb_array_elements(coalesce(_cfg->'task_weekdays', '[1,2,3,4,5]'::jsonb)) x)
     and ((_cfg->>'w_start_date') is null or d.d >= (_cfg->>'w_start_date')::date)
     and ((_cfg->>'w_end_date') is null or d.d <= (_cfg->>'w_end_date')::date)
     and exists (select 1 from unnest(_courses) cc(id)
                  where not exists (select 1 from public.challenge_tasks t
                                     where t.course_id = cc.id and t.task_date = d.d and t.status <> 'cancelled'));
  select w.asked_at, w.reminded_on, w.approved_at, w.approved_by, p.name::text as approved_by_name
    into _l
    from public.challenge_task_week_approvals w
    left join public.profiles p on p.id = w.approved_by
   where w.week_start = _week_start;
  return jsonb_build_object(
    'week_start', _week_start, 'week_end', _week_start + 6, 'course_ids', to_jsonb(_courses),
    'multi_course', cardinality(_courses) > 1, 'tasks', _tasks, 'missing', _missing,
    'counts', public.challenge_task_week_counts(_week_start, _cfg, _course_id),
    'post_time', coalesce(_cfg->>'post_time', '09:00'),
    'asked_at', _l.asked_at, 'approved_at', _l.approved_at, 'approved_by_name', _l.approved_by_name,
    'admin_url', 'https://www.aicreator.academy/admin/challenge/tasks?week=' || to_char(_week_start, 'YYYY-MM-DD'));
end
$fn$;

-- ═══════════════════════════════ 4. The tick (cron, every 5 minutes) ═══════════════════════════════
create or replace function public.challenge_tasks_week_approval_tick(_at timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Decides and ENQUEUES only (the worker renders and sends). See the file header §3. While paused (not active, or
-- approval.enabled = false): the heartbeat ONLY -- nothing queued, sent or kicked. Every section in its own sub-block; a
-- failing section is recorded once a day ('challenge_week_approval_tick_failed') and in the heartbeat's errors.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _ap jsonb;
  _plan jsonb;
  _prev jsonb;
  _today date := public.challenge_task_local_date(_at);
  _day_start timestamptz := (public.challenge_task_local_date(_at)::timestamp at time zone 'Asia/Tashkent');
  _lt time := (_at at time zone 'Asia/Tashkent')::time;
  _dow int := extract(isodow from public.challenge_task_local_date(_at))::int;
  _week date;
  _ask_at timestamptz;
  _quiet boolean;
  _courses uuid[];
  _cnt jsonb;
  _l public.challenge_task_week_approvals;
  _kind text;
  _n int := 0;
  _out jsonb := '{}'::jsonb;
  _err jsonb := '{}'::jsonb;
  _state text;
  _active_since timestamptz;
  _kicked boolean := false;
  _pending int := 0;
  _k text;
  _v jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('challenge_tasks_week_approval_tick')) then
    return jsonb_build_object('state', 'busy');
  end if;
  select value into _prev from public.app_settings where key = 'challenge_tasks_week_approval_state';
  _prev := coalesce(_prev, '{}'::jsonb);
  _ap := public.challenge_task_approval_parse((select ps.value->'approval' from public.platform_settings ps
                                                where ps.key = 'challenge_tasks'));
  _state := case when not coalesce((_cfg->>'active')::boolean, false) then 'inactive'
                 when not coalesce((_ap->>'enabled')::boolean, true) then 'disabled'
                 else 'active' end;

  if _state <> 'active' then
    insert into public.app_settings (key, value, description)
    values ('challenge_tasks_week_approval_state',
            jsonb_build_object('checked_at', _at, 'state', _state, 'active_since', null,
                               'last_kick_at', _prev->'last_kick_at'),
            'Daily Tasks PR-9: heartbeat of cron challenge-tasks-week-approval. Written by challenge_tasks_week_approval_tick().')
    on conflict (key) do update set value = excluded.value, updated_at = now();
    return jsonb_build_object('state', _state);
  end if;

  _active_since := case when _prev->>'state' = 'active' and _prev->>'active_since' is not null
                        then (_prev->>'active_since')::timestamptz else _at end;
  -- a malformed approval setting: its default is used, and it is DB-visible once a day
  if jsonb_array_length(_ap->'invalid') > 0
     and not exists (select 1 from public.admin_actions a
                      where a.action = 'challenge_week_approval_config_invalid' and a.created_at >= _day_start
                        and a.details->'keys' = _ap->'invalid') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_week_approval_config_invalid', jsonb_build_object('keys', _ap->'invalid', 'at', _at));
  end if;

  _plan := public.challenge_task_week_plan(_at, _ap);
  _week := (_plan->>'week_start')::date;
  _ask_at := (_plan->>'ask_at')::timestamptz;
  _quiet := public.challenge_task_in_quiet(_lt, coalesce((_cfg->>'quiet_start')::time, time '22:00'),
                                           coalesce((_cfg->>'quiet_end')::time, time '08:00'));

  -- (a) decide: ask / remind / no-tasks note, at most ONE per run
  if _at >= _ask_at and not _quiet then
    begin
      _courses := public.challenge_task_week_courses();
      if cardinality(_courses) > 0 then
        _cnt := public.challenge_task_week_counts(_week, _cfg, null);
        select * into _l from public.challenge_task_week_approvals w where w.week_start = _week;
        _kind := null;
        if (_cnt->>'drafts')::int > 0 and _l.asked_at is null then
          _kind := 'ask';
        elsif (_cnt->>'drafts')::int > 0 and _l.asked_at is not null
              and _dow in (select (x #>> '{}')::int from jsonb_array_elements(_ap->'remind_dows') x)
              and _lt >= (_ap->>'remind_time')::time
              and not (_today = any(coalesce(_l.reminded_on, '{}'::date[])))
              and public.challenge_task_local_date(_l.asked_at) < _today then
          _kind := 'remind';
        elsif (_cnt->>'live')::int = 0 and (_cnt->>'configured_days')::int > 0 and _l.no_tasks_at is null then
          _kind := 'no_tasks';
        end if;

        if _kind is not null then
          insert into public.challenge_task_week_approvals (week_start, course_ids) values (_week, _courses)
          on conflict (week_start) do nothing;
          insert into public.challenge_task_week_approval_messages (week_start, kind, sent_on, user_id, chat_id)
          select _week, _kind, _today, r.user_id, r.telegram_id from public.challenge_task_week_recipients() r
          on conflict (week_start, kind, sent_on, user_id) do nothing;
          get diagnostics _n = row_count;
          update public.challenge_task_week_approvals w
             set course_ids = _courses,
                 asked_at = case when _kind = 'ask' then _at else w.asked_at end,
                 reminded_on = case when _kind = 'remind' then array_append(w.reminded_on, _today) else w.reminded_on end,
                 no_tasks_at = case when _kind = 'no_tasks' then _at else w.no_tasks_at end,
                 updated_at = now()
           where w.week_start = _week;
          insert into public.admin_actions (actor_user_id, action, details)
          values (null, case _kind when 'ask' then 'challenge_week_approval_asked'
                                   when 'remind' then 'challenge_week_approval_reminded'
                                   else 'challenge_week_approval_no_tasks' end,
                  jsonb_build_object('week', _week, 'recipients', _n, 'counts', _cnt, 'ask_at', _ask_at,
                                     'late_min', greatest(0, floor(extract(epoch from (_at - _ask_at)) / 60))::int, 'at', _at));
          if _n = 0 then
            -- nobody to tell: graceful is not silent (and the watchdog alarms if the ask stays undelivered)
            insert into public.admin_actions (actor_user_id, action, details)
            values (null, 'challenge_week_approval_undelivered', jsonb_build_object(
              'week', _week, 'kind', _kind, 'sent_on', _today, 'reason', 'no_admin_recipients', 'at', _at));
          end if;
          _out := _out || jsonb_build_object(_kind, _n);
        end if;
      end if;
    exception when others then
      _err := _err || jsonb_build_object('decide', left(sqlerrm, 200));
    end;
  end if;

  -- (b) kick the worker when a claim would lease something (same filter as challenge_task_week_msg_claim), outside quiet
  --     hours; a retry kick at most every 4 minutes
  if not _quiet then
    begin
      select count(*)::int into _pending
        from public.challenge_task_week_approval_messages m
       where (m.state = 'pending'
              or (m.state = 'sending' and m.claimed_at < now() - interval '5 minutes' and m.attempts < 3)
              or (m.state = 'failed' and not m.terminal and m.attempts < 3 and m.claimed_at < now() - interval '10 minutes'))
         and m.week_start > _today;
      if _pending > 0 and (_out <> '{}'::jsonb or _prev->>'last_kick_at' is null
                           or (_prev->>'last_kick_at')::timestamptz < _at - interval '4 minutes') then
        perform public.ops_net_post(
          p_url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/challenge-tasks-worker',
          p_body := jsonb_build_object('mode', 'week_approval', 'pending', _pending),
          p_headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
                                          'Authorization', 'Bearer ' || public.cron_service_key(),
                                          'x-internal-secret', public.internal_fn_secret()),
          p_purpose := 'challenge-tasks-week-approval',
          p_timeout_ms := 60000);
        _kicked := true;
      end if;
    exception when others then
      _err := _err || jsonb_build_object('kick', left(sqlerrm, 200));
    end;
  end if;

  for _k, _v in select key, value from jsonb_each(_err) loop
    if not exists (select 1 from public.admin_actions a
                    where a.action = 'challenge_week_approval_tick_failed' and a.created_at >= _day_start
                      and a.details->>'section' = _k) then
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_week_approval_tick_failed', jsonb_build_object('section', _k, 'error', _v, 'at', _at));
    end if;
  end loop;

  insert into public.app_settings (key, value, description)
  values ('challenge_tasks_week_approval_state',
          jsonb_build_object('checked_at', _at, 'state', 'active', 'active_since', _active_since, 'week', _week,
                             'ask_at', _ask_at, 'quiet', _quiet, 'last_out', _out, 'errors', _err, 'pending', _pending,
                             'kicked', _kicked,
                             'last_kick_at', case when _kicked then to_jsonb(_at) else coalesce(_prev->'last_kick_at', 'null'::jsonb) end),
          'Daily Tasks PR-9: heartbeat of cron challenge-tasks-week-approval. Written by challenge_tasks_week_approval_tick().')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('state', 'active', 'week', _week, 'ask_at', _ask_at, 'quiet', _quiet, 'out', _out,
                            'errors', _err, 'pending', _pending, 'kicked', _kicked);
end
$fn$;

-- ═══════════════════════════════ 5. Claim / record for challenge-tasks-worker {mode: 'week_approval'} ═══════════════════════════════
create or replace function public.challenge_task_week_msg_claim(_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Leases due admin messages. Never inside quiet hours, only while active. A message of a week that already started, or
-- a reminder from an earlier day, is never sent late ('skipped' / expired); an ask or reminder whose week has no draft
-- left (approved meanwhile, e.g. on the web) is 'skipped' / nothing_to_approve. A send that failed transiently is
-- re-offered after 10 minutes, at most 3 attempts.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _today date := public.challenge_task_local_date(now());
  _out jsonb := '[]'::jsonb;
  _r record;
  _tok uuid;
  _drafts jsonb := '{}'::jsonb;
  _d int;
begin
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'inactive', 'items', '[]'::jsonb);
  end if;
  if public.challenge_task_in_quiet((now() at time zone 'Asia/Tashkent')::time, coalesce((_cfg->>'quiet_start')::time, time '22:00'),
                                    coalesce((_cfg->>'quiet_end')::time, time '08:00')) then
    return jsonb_build_object('ok', false, 'reason', 'quiet_hours', 'items', '[]'::jsonb);
  end if;
  -- a lease abandoned on its last attempt ends as failed (never 'sending' forever)
  update public.challenge_task_week_approval_messages m
     set state = 'failed', terminal = true, claim_token = null, error = left(coalesce(m.error || '; ', '') || 'lease_expired', 300)
   where m.state = 'sending' and m.claimed_at < now() - interval '5 minutes' and m.attempts >= 3;
  -- still open, but too late to send: skipped (a finished failure keeps its own error)
  update public.challenge_task_week_approval_messages m
     set state = 'skipped', terminal = true, claim_token = null, error = left('expired' || coalesce(' (' || m.error || ')', ''), 300)
   where (m.state = 'pending'
          or (m.state = 'failed' and not m.terminal and m.attempts < 3)
          or (m.state = 'sending' and m.claimed_at < now() - interval '5 minutes'))
     and (m.week_start <= _today or (m.kind = 'remind' and m.sent_on < _today));
  for _r in
    select m.id, m.kind, m.week_start, m.chat_id, m.user_id
      from public.challenge_task_week_approval_messages m
     where (m.state = 'pending'
            or (m.state = 'sending' and m.claimed_at < now() - interval '5 minutes' and m.attempts < 3)
            or (m.state = 'failed' and not m.terminal and m.attempts < 3 and m.claimed_at < now() - interval '10 minutes'))
       and m.week_start > _today
     order by m.id
     limit greatest(1, least(coalesce(_limit, 10), 50))
     for update of m skip locked
  loop
    if _r.kind in ('ask', 'remind') then
      if not (_drafts ? _r.week_start::text) then
        _drafts := _drafts || jsonb_build_object(_r.week_start::text,
                     (public.challenge_task_week_counts(_r.week_start, _cfg, null)->>'drafts')::int);
      end if;
      _d := (_drafts->>(_r.week_start::text))::int;
      if _d = 0 then
        update public.challenge_task_week_approval_messages
           set state = 'skipped', terminal = true, claim_token = null, error = 'nothing_to_approve'
         where id = _r.id;
        continue;
      end if;
    end if;
    _tok := gen_random_uuid();
    update public.challenge_task_week_approval_messages
       set state = 'sending', claim_token = _tok, claimed_at = now(), attempts = attempts + 1
     where id = _r.id;
    _out := _out || jsonb_build_object('id', _r.id, 'token', _tok, 'kind', _r.kind, 'week_start', _r.week_start,
                                       'chat_id', _r.chat_id, 'user_id', _r.user_id);
  end loop;
  return jsonb_build_object('ok', true, 'items', _out);
end
$fn$;

create or replace function public.challenge_task_week_msg_record(_id bigint, _token uuid, _ok boolean, _message_id bigint default null,
                                                              _error text default null, _terminal boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The worker's outcome for one leased message (the lease token must still match). When the LAST open message of a batch
-- (week, kind, day) ends and no admin got it: 'challenge_week_approval_undelivered' (once per batch).
declare
  _m public.challenge_task_week_approval_messages;
begin
  update public.challenge_task_week_approval_messages
     set state = case when _ok and _message_id is not null then 'sent' else 'failed' end,
         message_id = case when _ok then _message_id else message_id end,
         sent_at = case when _ok and _message_id is not null then now() else sent_at end,
         error = case when _ok and _message_id is not null then null else left(coalesce(_error, 'no message id'), 300) end,
         terminal = (not (_ok and _message_id is not null)) and coalesce(_terminal, false),
         claim_token = null
   where id = _id and claim_token = _token and state = 'sending'
  returning * into _m;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  if _m.state = 'failed' and (_m.terminal or _m.attempts >= 3)
     and not exists (select 1 from public.challenge_task_week_approval_messages x
                      where x.week_start = _m.week_start and x.kind = _m.kind and x.sent_on = _m.sent_on
                        and (x.state in ('pending', 'sending', 'sent')
                             or (x.state = 'failed' and not x.terminal and x.attempts < 3)))
     and not exists (select 1 from public.admin_actions a
                      where a.action = 'challenge_week_approval_undelivered' and a.details->>'week' = _m.week_start::text
                        and a.details->>'kind' = _m.kind and a.details->>'sent_on' = _m.sent_on::text) then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_week_approval_undelivered', jsonb_build_object(
      'week', _m.week_start, 'kind', _m.kind, 'sent_on', _m.sent_on, 'reason', 'send_failed',
      'errors', (select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'error', x.error) order by x.id)
                   from public.challenge_task_week_approval_messages x
                  where x.week_start = _m.week_start and x.kind = _m.kind and x.sent_on = _m.sent_on),
      'at', now()));
  end if;
  return jsonb_build_object('ok', true, 'state', _m.state);
end
$fn$;

-- ═══════════════════════════════ 6. The approval (bot as service_role with the real clicker; web as the admin) ═══════════════════════════════
create or replace function public.challenge_tasks_approve_week(_week_start date, _actor uuid default null, _course_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Approves every DRAFT task of the Monday.._week_start+6 week (challenge course(s), or _course_id) one by one through
-- trg_challenge_tasks_guard, which validates each and stamps approved_by := auth.uid(). A row the guard refuses is
-- reported in failed[] and the others still go through. See the file header §4 for who may call it.
declare
  _role text := coalesce(auth.role(), '');
  _uid uuid := auth.uid();
  _who uuid;
  _via text;
  _courses uuid[];
  _ids bigint[];
  _id bigint;
  _t record;
  _approved bigint[] := '{}';
  _failed jsonb := '[]'::jsonb;
  _already int;
  _left int;
  _old_claims text;
  _old_sub text;
  _name text;
  _res jsonb;
begin
  if _role = 'service_role' then
    if _actor is null then
      raise exception using errcode = '42501', message = 'challenge_tasks_approve_week: _actor is required';
    end if;
    _who := _actor;
    _via := 'telegram';
  elsif _role = 'authenticated' then
    if _uid is null or (_actor is not null and _actor <> _uid) then
      raise exception using errcode = '42501', message = 'challenge_tasks_approve_week: not allowed';
    end if;
    _who := _uid;
    _via := 'web';
  else
    raise exception using errcode = '42501', message = 'challenge_tasks_approve_week: not allowed';
  end if;
  if not public.has_role(_who, 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Faqat admin haftani tasdiqlay oladi';
  end if;
  if _week_start is null or extract(isodow from _week_start) <> 1 then
    raise exception using errcode = '22023', message = 'Hafta dushanbadan boshlanishi kerak';
  end if;
  _courses := case when _course_id is not null then array[_course_id] else public.challenge_task_week_courses() end;
  -- one approval of a week at a time: a double tap or a second admin waits, then finds nothing left to approve
  perform pg_advisory_xact_lock(hashtext('challenge_tasks_approve_week:' || _week_start::text));

  select coalesce(array_agg(t.id order by t.task_date, t.id), '{}') into _ids
    from public.challenge_tasks t
   where t.course_id = any(_courses) and t.task_date between _week_start and _week_start + 6 and t.status = 'draft';
  _already := (select count(*)::int from public.challenge_tasks t
                where t.course_id = any(_courses) and t.task_date between _week_start and _week_start + 6
                  and t.status = 'approved');

  -- the guard stamps approved_by := auth.uid(): for the bot (service_role, no sub) the claims are set LOCALLY to the
  -- verified admin for the loop, then restored (both the claims json and the legacy claim.sub that auth.uid() prefers)
  _old_claims := current_setting('request.jwt.claims', true);
  _old_sub := current_setting('request.jwt.claim.sub', true);
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', jsonb_build_object('sub', _who, 'role', 'service_role')::text, true);
    perform set_config('request.jwt.claim.sub', _who::text, true);
  end if;
  foreach _id in array _ids loop
    begin
      update public.challenge_tasks set status = 'approved' where id = _id and status = 'draft';
      if found then
        _approved := _approved || _id;
      end if;
    exception when others then
      select t.task_date, t.title, t.course_id into _t from public.challenge_tasks t where t.id = _id;
      _failed := _failed || jsonb_build_object('task_id', _id, 'date', _t.task_date, 'title', _t.title,
                                               'course_id', _t.course_id, 'error', left(sqlerrm, 300));
    end;
  end loop;
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', coalesce(_old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(_old_sub, ''), true);
  end if;

  _left := (select count(*)::int from public.challenge_tasks t
             where t.course_id = any(_courses) and t.task_date between _week_start and _week_start + 6 and t.status = 'draft');
  _name := (select p.name::text from public.profiles p where p.id = _who);
  _res := jsonb_build_object('ok', true, 'week_start', _week_start, 'via', _via, 'approved', cardinality(_approved),
                             'already_approved', _already, 'failed', _failed, 'drafts_left', _left,
                             'total', _already + cardinality(_approved) + _left, 'task_ids', to_jsonb(_approved),
                             'actor', _who, 'actor_name', _name, 'course_ids', to_jsonb(_courses));

  insert into public.challenge_task_week_approvals as w (week_start, course_ids, approved_at, approved_by, last_result)
  values (_week_start, _courses, case when cardinality(_approved) > 0 then now() end,
          case when cardinality(_approved) > 0 then _who end, _res)
  on conflict (week_start) do update
    set approved_at = coalesce(excluded.approved_at, w.approved_at),
        approved_by = case when excluded.approved_at is not null then excluded.approved_by else w.approved_by end,
        last_result = excluded.last_result, updated_at = now();
  insert into public.admin_actions (actor_user_id, action, details)
  values (_who, 'challenge_week_approved', jsonb_build_object(
    'week', _week_start, 'via', _via, 'approved', cardinality(_approved), 'already_approved', _already,
    'failed', _failed, 'failed_count', jsonb_array_length(_failed), 'drafts_left', _left, 'task_ids', to_jsonb(_approved),
    'course_ids', to_jsonb(_courses), 'noop', cardinality(_approved) = 0 and jsonb_array_length(_failed) = 0, 'at', now()));
  return _res;
end
$fn$;

create or replace function public.challenge_task_week_edits_record(_week_start date, _actor uuid, _results jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The bot, after an approval: the outcome of editing every OTHER admin's copy (ask / reminder) to the result. One
-- 'challenge_week_approval_copies_updated' row per approval (best effort, DB-visible).
declare
  _e jsonb;
  _ok int := 0;
  _bad int := 0;
begin
  for _e in select value from jsonb_array_elements(case when jsonb_typeof(_results) = 'array' then _results else '[]'::jsonb end) loop
    if (_e->>'id') !~ '^[0-9]{1,18}$' then
      continue;
    end if;
    if coalesce((_e->>'ok')::boolean, false) then
      update public.challenge_task_week_approval_messages set edited_at = now(), edit_error = null
       where id = (_e->>'id')::bigint and week_start = _week_start;
      _ok := _ok + 1;
    else
      update public.challenge_task_week_approval_messages set edit_error = left(coalesce(_e->>'error', 'edit_failed'), 300)
       where id = (_e->>'id')::bigint and week_start = _week_start;
      _bad := _bad + 1;
    end if;
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (_actor, 'challenge_week_approval_copies_updated', jsonb_build_object(
    'week', _week_start, 'edited', _ok, 'failed', _bad, 'results', _results, 'at', now()));
  return jsonb_build_object('ok', true, 'edited', _ok, 'failed', _bad);
end
$fn$;

-- ═══════════════════════════════ 7. Health (read-only; the watchdog reads it) ═══════════════════════════════
create or replace function public.challenge_task_week_approval_health(_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- undelivered_alarm: active (and approval.enabled), the tick has seen it (state 'active'), inside the ask window, drafts
-- remain, no ask / reminder of the target week reached ANY admin, not quiet hours now, and the ask has been due for
-- more than 2 hours -- due since the latest of: when it was queued (else its scheduled time), when this tick first saw
-- the feature active (a go-live after Thursday asks then), and the end of the last quiet hours (nothing is sent at night).
-- silent: the tick's heartbeat is missing or older than 20 minutes while the feature is active.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _ap jsonb := public.challenge_task_approval_parse((select ps.value->'approval' from public.platform_settings ps
                                                      where ps.key = 'challenge_tasks'));
  _plan jsonb;
  _week date;
  _ask_at timestamptz;
  _st jsonb;
  _l record;
  _cnt jsonb;
  _qs time := coalesce((_cfg->>'quiet_start')::time, time '22:00');
  _qe time := coalesce((_cfg->>'quiet_end')::time, time '08:00');
  _lt time := (_at at time zone 'Asia/Tashkent')::time;
  _qe_ts timestamptz;
  _due timestamptz;
  _enabled boolean;
  _msgs jsonb;
  _sent int;
  _alarm boolean := false;
  _silent boolean := false;
begin
  _plan := public.challenge_task_week_plan(_at, _ap);
  _week := (_plan->>'week_start')::date;
  _ask_at := (_plan->>'ask_at')::timestamptz;
  select value into _st from public.app_settings where key = 'challenge_tasks_week_approval_state';
  _enabled := coalesce((_cfg->>'active')::boolean, false) and coalesce((_ap->>'enabled')::boolean, true);
  _cnt := public.challenge_task_week_counts(_week, _cfg, null);
  select w.asked_at, w.reminded_on, w.approved_at, w.no_tasks_at into _l
    from public.challenge_task_week_approvals w where w.week_start = _week;
  select coalesce(jsonb_object_agg(x.state, x.n), '{}'::jsonb) into _msgs
    from (select m.state, count(*)::int as n from public.challenge_task_week_approval_messages m
           where m.week_start = _week and m.kind in ('ask', 'remind') group by m.state) x;
  _sent := coalesce((_msgs->>'sent')::int, 0);
  _qe_ts := ((_at at time zone 'Asia/Tashkent')::date + _qe)::timestamp at time zone 'Asia/Tashkent';
  if _qe_ts > _at then
    _qe_ts := _qe_ts - interval '1 day';
  end if;
  _silent := _enabled and (_st is null or coalesce((_st->>'checked_at')::timestamptz, '-infinity'::timestamptz) < _at - interval '20 minutes');
  _due := greatest(coalesce(_l.asked_at, _ask_at),
                   case when _st->>'state' = 'active' then (_st->>'active_since')::timestamptz end,
                   _qe_ts);
  _alarm := _enabled and coalesce(_st->>'state', '') = 'active'
            and _at >= _ask_at and _at < (_plan->>'week_ts')::timestamptz
            and coalesce((_cnt->>'drafts')::int, 0) > 0 and _sent = 0
            and not public.challenge_task_in_quiet(_lt, _qs, _qe)
            and _due <= _at - interval '2 hours';
  return jsonb_build_object(
    'enabled', _enabled, 'approval', _ap, 'week_start', _week, 'ask_at', _ask_at, 'counts', _cnt,
    'asked_at', _l.asked_at, 'reminded_on', to_jsonb(_l.reminded_on), 'approved_at', _l.approved_at, 'no_tasks_at', _l.no_tasks_at,
    'messages', _msgs, 'due_since', _due, 'undelivered_alarm', _alarm, 'silent', _silent,
    'tick', case when _st is not null then jsonb_build_object('checked_at', _st->'checked_at', 'state', _st->'state',
                                                               'active_since', _st->'active_since', 'errors', _st->'errors') end,
    'admin_url', 'https://www.aicreator.academy/admin/challenge/tasks?week=' || to_char(_week, 'YYYY-MM-DD'),
    'at', _at);
end
$fn$;

-- ═══════════════════════════════ 8. Pinned rewrite: challenge_tasks_watchdog watches the weekly approval ═══════════════════════════════
-- ONE anchor (the alarm de-duplication line), asserted to occur exactly once; the block is inserted before it (after
-- PR-5's block). The watchdog is independent of both legs it watches: its own cron and its own pg_net DM path.
do $$
declare
  _pin constant text := 'ab091a8a4dfba493296490c558d6d198';       -- live md5(prosrc), read 2026-09-30 (= PR-5's _new_pin)
  _new_pin constant text := '4e486bae40cdcf9078536241822d04e2';   -- the rewritten body (PGlite harness + an independent recompute)
  _anchor constant text := E'  select coalesce(array_agg(distinct a), ''{}'') into _alarms from unnest(_alarms) a;\n';
  _block constant text :=
       E'  -- 20260930200000 (Daily Tasks PR-9): the weekly Telegram approval, watched from here (independent of its tick and the worker)\n'
    || E'  begin\n'
    || E'    _g := public.challenge_task_week_approval_health(_at);\n'
    || E'    if coalesce((_g->>''silent'')::boolean, false) then\n'
    || E'      _alarms := _alarms || ''week_approval_silent''::text;\n'
    || E'      _msgs := _msgs || ''Haftalik tasdiqlash taymeri (challenge_tasks_week_approval_tick) 20 daqiqadan beri ishlamadi.''::text;\n'
    || E'    end if;\n'
    || E'    if coalesce((_g->>''undelivered_alarm'')::boolean, false) then\n'
    || E'      _alarms := _alarms || ''week_approval_undelivered''::text;\n'
    || E'      _msgs := _msgs || (''Keyingi hafta ('' || (_g->>''week_start'') || '') vazifalarini tasdiqlash so‘rovi 2 soatdan beri hech bir adminga yetib bormadi. Tasdiqlash: '' || (_g->>''admin_url''));\n'
    || E'    end if;\n'
    || E'  exception when others then\n'
    || E'    _alarms := _alarms || ''week_approval_watch_crashed''::text;\n'
    || E'    _msgs := _msgs || (''Haftalik tasdiqlash kuzatuvi xato: '' || left(sqlerrm, 150));\n'
    || E'  end;\n'
    || E'\n';
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _fn := to_regprocedure('public.challenge_tasks_watchdog(timestamptz)');
  if _fn is null then
    raise exception 'ABORT: public.challenge_tasks_watchdog(timestamptz) not found';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef from pg_proc where oid = _fn;
  if position('challenge_task_week_approval_health' in _src) > 0 then   -- replay: the marker exists only after this rewrite
    raise notice 'challenge_tasks_watchdog already watches the weekly approval -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: challenge_tasks_watchdog changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;
  _def := pg_get_functiondef(_fn);
  _n := (length(_def) - length(replace(_def, _anchor, ''))) / length(_anchor);
  if _n <> 1 then
    raise exception 'ABORT: challenge_tasks_watchdog anchor matched % times (want exactly 1)', _n;
  end if;
  _new := replace(_def, _anchor, _block || _anchor);
  execute _new;
  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: challenge_tasks_watchdog -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: challenge_tasks_watchdog -- owner, ACL or SECURITY DEFINER changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: challenge_tasks_watchdog -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 9. RLS, grants ═══════════════════════════════
alter table public.challenge_task_week_approvals enable row level security;
alter table public.challenge_task_week_approval_messages enable row level security;
drop policy if exists "challenge_task_week_approvals admin read" on public.challenge_task_week_approvals;
create policy "challenge_task_week_approvals admin read" on public.challenge_task_week_approvals
  for select to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role));
drop policy if exists "challenge_task_week_approval_messages admin read" on public.challenge_task_week_approval_messages;
create policy "challenge_task_week_approval_messages admin read" on public.challenge_task_week_approval_messages
  for select to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role));

revoke all on table public.challenge_task_week_approvals from public, anon, authenticated;
revoke all on table public.challenge_task_week_approval_messages from public, anon, authenticated;
grant select on table public.challenge_task_week_approvals to authenticated;           -- RLS: admins only
grant select on table public.challenge_task_week_approval_messages to authenticated;   -- RLS: admins only
grant select, insert, update, delete on table public.challenge_task_week_approvals to service_role;
grant select, insert, update, delete on table public.challenge_task_week_approval_messages to service_role;
do $$
declare
  _s text := pg_get_serial_sequence('public.challenge_task_week_approval_messages', 'id');
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', _s);
  execute format('grant usage, select on sequence %s to service_role', _s);
end $$;

-- anon and authenticated inherit PUBLIC, so every revoke names PUBLIC first
revoke execute on function public.challenge_task_approval_parse(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_approval_parse(jsonb) to service_role;
revoke execute on function public.challenge_task_week_plan(timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_week_plan(timestamptz, jsonb) to service_role;
revoke execute on function public.challenge_task_in_quiet(time, time, time) from public, anon, authenticated;
grant execute on function public.challenge_task_in_quiet(time, time, time) to service_role;
revoke execute on function public.challenge_task_week_courses() from public, anon, authenticated;
grant execute on function public.challenge_task_week_courses() to service_role;
revoke execute on function public.challenge_task_week_recipients() from public, anon, authenticated;
grant execute on function public.challenge_task_week_recipients() to service_role;
revoke execute on function public.challenge_task_week_counts(date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_week_counts(date, jsonb, uuid) to service_role;
revoke execute on function public.challenge_task_week_view(date, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_week_view(date, uuid) to service_role;
revoke execute on function public.challenge_tasks_week_approval_tick(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_tasks_week_approval_tick(timestamptz) to service_role;
revoke execute on function public.challenge_task_week_msg_claim(integer) from public, anon, authenticated;
grant execute on function public.challenge_task_week_msg_claim(integer) to service_role;
revoke execute on function public.challenge_task_week_msg_record(bigint, uuid, boolean, bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.challenge_task_week_msg_record(bigint, uuid, boolean, bigint, text, boolean) to service_role;
revoke execute on function public.challenge_tasks_approve_week(date, uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_tasks_approve_week(date, uuid, uuid) to authenticated, service_role;   -- admin check inside
revoke execute on function public.challenge_task_week_edits_record(date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_week_edits_record(date, uuid, jsonb) to service_role;
revoke execute on function public.challenge_task_week_approval_health(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_week_approval_health(timestamptz) to service_role;

-- ═══════════════════════════════ 10. The setting (merge: every other key kept; an existing 'approval' never overwritten) ═══════════════════════════════
update public.platform_settings
   set value = value || jsonb_build_object('approval', jsonb_build_object(
                 'enabled', true, 'ask_dow', 4, 'ask_time', '12:00', 'remind_dows', jsonb_build_array(6, 7), 'remind_time', '19:00')),
       updated_at = now()
 where key = 'challenge_tasks' and jsonb_typeof(value) = 'object' and not (value ? 'approval');

-- ═══════════════════════════════ 11. Cron (inert while paused: a heartbeat stamp only) ═══════════════════════════════
do $$
declare _j record;
begin
  for _j in select jobid from cron.job where jobname = 'challenge-tasks-week-approval' loop
    perform cron.unschedule(_j.jobid);
  end loop;
end $$;
select cron.schedule('challenge-tasks-week-approval', '*/5 * * * *', $c$ select public.challenge_tasks_week_approval_tick() $c$);

-- ═══════════════════════════════ 12. Self-test (NON-mutating: pure fixtures, catalog, ACLs, cron, the rewrite, read-only calls) ═══════════════════════════════
-- Never calls the tick, the approve RPC, a claim, a record or the edits recorder; never sends.
do $$
declare
  _bad text[] := '{}';
  _r record;
  _p jsonb;
  _v jsonb;
  _h jsonb;
  _src text;
  _f jsonb;
  _cases jsonb := '[
    [null,                                                   true, 4, "12:00", [6,7], "19:00", []],
    [{},                                                     true, 4, "12:00", [6,7], "19:00", []],
    [{"enabled":false,"ask_dow":5,"ask_time":"10:30","remind_dows":[7,6,6],"remind_time":"20:15"}, false, 5, "10:30", [6,7], "20:15", []],
    [{"enabled":"yes","ask_dow":8,"ask_time":"25:00","remind_dows":"6,7","remind_time":"7pm"}, true, 4, "12:00", [6,7], "19:00",
      ["approval.enabled","approval.ask_dow","approval.ask_time","approval.remind_time","approval.remind_dows"]],
    [{"ask_dow":3.5,"remind_dows":[0,6]},                    true, 4, "12:00", [6,7], "19:00", ["approval.ask_dow","approval.remind_dows"]],
    [{"remind_dows":[]},                                     true, 4, "12:00", [],    "19:00", []],
    [[1,2],                                                  true, 4, "12:00", [6,7], "19:00", ["approval"]]
  ]'::jsonb;
  -- _at (UTC), ask_dow, ask_time -> today (Tashkent), week_start, ask_at (UTC)
  _plans jsonb := '[
    ["2026-10-01T06:59:00Z", 4, "12:00", "2026-10-01", "2026-10-05", "2026-10-01T07:00:00+00:00"],
    ["2026-10-01T07:00:00Z", 4, "12:00", "2026-10-01", "2026-10-05", "2026-10-01T07:00:00+00:00"],
    ["2026-10-04T18:59:00Z", 4, "12:00", "2026-10-04", "2026-10-05", "2026-10-01T07:00:00+00:00"],
    ["2026-10-04T19:00:00Z", 4, "12:00", "2026-10-05", "2026-10-12", "2026-10-08T07:00:00+00:00"],
    ["2026-10-05T10:00:00Z", 7, "09:30", "2026-10-05", "2026-10-12", "2026-10-11T04:30:00+00:00"],
    ["2026-10-05T10:00:00Z", 1, "00:00", "2026-10-05", "2026-10-12", "2026-10-04T19:00:00+00:00"]
  ]'::jsonb;
begin
  -- (a) the setting parser
  for _f in select value from jsonb_array_elements(_cases) loop
    _p := public.challenge_task_approval_parse(case when jsonb_typeof(_f->0) = 'null' then null else _f->0 end);
    if _p->'enabled' is distinct from _f->1 or _p->'ask_dow' is distinct from _f->2 or _p->'ask_time' is distinct from _f->3
       or _p->'remind_dows' is distinct from _f->4 or _p->'remind_time' is distinct from _f->5
       or (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(_p->'invalid') x)
          is distinct from (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(_f->6) x) then
      _bad := _bad || ('parse:' || (_f->0)::text || '=' || _p::text);
    end if;
  end loop;
  -- (b) the week plan (pure)
  for _f in select value from jsonb_array_elements(_plans) loop
    _p := public.challenge_task_week_plan((_f->>0)::timestamptz, jsonb_build_object('ask_dow', (_f->>1)::int, 'ask_time', _f->>2));
    if _p->>'today' is distinct from _f->>3 or _p->>'week_start' is distinct from _f->>4
       or (_p->>'ask_at')::timestamptz is distinct from (_f->>5)::timestamptz then
      _bad := _bad || ('plan:' || (_f->>0) || '=' || _p::text);
    end if;
  end loop;
  if public.challenge_task_in_quiet(time '23:00', time '22:00', time '08:00') is not true
     or public.challenge_task_in_quiet(time '07:59', time '22:00', time '08:00') is not true
     or public.challenge_task_in_quiet(time '08:00', time '22:00', time '08:00') is not false
     or public.challenge_task_in_quiet(time '12:00', time '01:00', time '06:00') is not false
     or public.challenge_task_in_quiet(time '03:00', time '01:00', time '06:00') is not true then
    _bad := _bad || 'in_quiet'::text;
  end if;
  -- (c) objects, RLS, policies
  if not (select relrowsecurity from pg_class where oid = 'public.challenge_task_week_approvals'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.challenge_task_week_approval_messages'::regclass) then
    _bad := _bad || 'rls'::text;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public'
       and tablename in ('challenge_task_week_approvals', 'challenge_task_week_approval_messages')) <> 2 then
    _bad := _bad || 'policies'::text;
  end if;
  if has_table_privilege('anon', 'public.challenge_task_week_approvals', 'SELECT')
     or has_table_privilege('anon', 'public.challenge_task_week_approval_messages', 'SELECT')
     or has_table_privilege('authenticated', 'public.challenge_task_week_approval_messages', 'UPDATE')
     or has_table_privilege('authenticated', 'public.challenge_task_week_approvals', 'INSERT') then
    _bad := _bad || 'table_acl'::text;
  end if;
  -- (d) functions: SECURITY DEFINER where they read / write, never PUBLIC / anon; authenticated only on the approve RPC
  for _r in
    select p.proname, p.prosecdef, coalesce(array_to_string(p.proacl, ','), '') as acl,
           coalesce(array_to_string(p.proconfig, ','), '') as conf
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('challenge_task_approval_parse', 'challenge_task_week_plan', 'challenge_task_in_quiet',
                         'challenge_task_week_courses', 'challenge_task_week_recipients', 'challenge_task_week_counts',
                         'challenge_task_week_view', 'challenge_tasks_week_approval_tick', 'challenge_task_week_msg_claim',
                         'challenge_task_week_msg_record', 'challenge_tasks_approve_week', 'challenge_task_week_edits_record',
                         'challenge_task_week_approval_health')
  loop
    if _r.conf not like '%search_path=public%' then
      _bad := _bad || ('search_path:' || _r.proname);
    end if;
    if _r.proname not in ('challenge_task_approval_parse', 'challenge_task_week_plan', 'challenge_task_in_quiet') and not _r.prosecdef then
      _bad := _bad || ('definer:' || _r.proname);
    end if;
    if _r.acl = '' or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)anon=' or _r.acl !~ '(^|,)service_role=X' then
      _bad := _bad || ('acl:' || _r.proname || ':' || _r.acl);
    end if;
    if (_r.proname = 'challenge_tasks_approve_week') <> (_r.acl ~ '(^|,)authenticated=') then
      _bad := _bad || ('acl_authenticated:' || _r.proname || ':' || _r.acl);
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('challenge_task_approval_parse', 'challenge_task_week_plan', 'challenge_task_in_quiet',
                           'challenge_task_week_courses', 'challenge_task_week_recipients', 'challenge_task_week_counts',
                           'challenge_task_week_view', 'challenge_tasks_week_approval_tick', 'challenge_task_week_msg_claim',
                           'challenge_task_week_msg_record', 'challenge_tasks_approve_week', 'challenge_task_week_edits_record',
                           'challenge_task_week_approval_health')) <> 13 then
    _bad := _bad || 'functions_missing'::text;
  end if;
  -- (e) the cron row, exactly; every outbound call of the tick carries a Content-Type and goes through ops_net_post
  if (select count(*) from cron.job where jobname = 'challenge-tasks-week-approval' and schedule = '*/5 * * * *'
         and command = ' select public.challenge_tasks_week_approval_tick() ') <> 1 then
    _bad := _bad || 'cron'::text;
  end if;
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_week_approval_tick(timestamptz)'::regprocedure);
  if (length(_src) - length(replace(_src, 'public.ops_net_post(', ''))) / length('public.ops_net_post(') <> 1
     or position('''Content-Type'', ''application/json''' in _src) = 0 then
    _bad := _bad || 'tick_outbound'::text;
  end if;
  -- (f) the pinned rewrite landed
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure);
  if position('challenge_task_week_approval_health' in _src) = 0 or position('''week_approval_undelivered''' in _src) = 0
     or position('''week_approval_silent''' in _src) = 0 or position('challenge_tasks_tick_state' in _src) = 0 then
    _bad := _bad || 'watchdog_rewrite'::text;
  end if;
  -- (g) the setting exists after the merge (or was already there) and parses
  if not exists (select 1 from public.platform_settings where key = 'challenge_tasks' and value ? 'approval') then
    _bad := _bad || 'setting_missing'::text;
  end if;
  -- (h) read-only calls answer their shape (the view of next week, the health now)
  _v := public.challenge_task_week_view((public.challenge_task_week_plan(now(), '{}'::jsonb)->>'week_start')::date, null);
  if jsonb_typeof(_v->'tasks') is distinct from 'array' or jsonb_typeof(_v->'counts') is distinct from 'object'
     or _v->>'admin_url' !~ '^https://www\.aicreator\.academy/admin/challenge/tasks\?week=[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    _bad := _bad || ('view_shape:' || left(_v::text, 200));
  end if;
  _h := public.challenge_task_week_approval_health(now());
  if jsonb_typeof(_h->'undelivered_alarm') is distinct from 'boolean' or jsonb_typeof(_h->'silent') is distinct from 'boolean' then
    _bad := _bad || ('health_shape:' || left(_h::text, 200));
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: weekly approval self-test failed: %', array_to_string(_bad, ', ');
  end if;
end $$;

-- ═══════════════════════════════ 13. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_tasks_week_approval_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_tasks_week_approval_applied', jsonb_build_object(
      'tables', jsonb_build_array('challenge_task_week_approvals', 'challenge_task_week_approval_messages'),
      'rpc', 'challenge_tasks_approve_week',
      'cron', 'challenge-tasks-week-approval */5 * * * *',
      'approval', (select value->'approval' from public.platform_settings where key = 'challenge_tasks'),
      'recipients', (select count(*) from public.challenge_task_week_recipients()),
      'watchdog_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure),
      'at', now()));
  end if;
end $$;
