-- Challenge 6.0 daily tasks: the fixes due before the first live post (Monday 2026-10-05 09:00 Tashkent). Six live
-- functions get a pinned, surgical rewrite. Nothing new is created, no grant changes, no data is written except the
-- one audit row.
--
-- ═══ WHAT WAS WRONG (each one checked read-only against production on 2026-10-01, ~05:45 UTC) ═══
-- 1. Nothing warns if nobody approves week 1. challenge_task_is_task_day() started the calendar at min(task_date) of
--    APPROVED tasks. Production has 25 drafts (2026-10-05 .. 11-06) and 0 approved tasks, so that start was 'infinity'
--    and no date was a task day. The tick's 18:00 "tomorrow is not approved" DM (section e), its 'no_task_today' row
--    (section a), and the watchdog's no_task_today / no_task_tomorrow alarms all skip a day that is not a task day.
--    If week 1 is never approved, Monday 09:00 posts nothing and nothing alarms. Once Monday starts, the weekly
--    approval targets week 10-12, so week 10-05 is never asked about again. The go-live file (20260930203000) wrote
--    this down as a BLIND SPOT.
-- 2. held_senders can alarm before there is any task day. In challenge_tasks_watchdog it fires on one held sender
--    today (held_24h.today >= 1) without the task-day gate the other calendar alarms have (I10). webhook_inbox shows
--    a '2-GURUH VIP 5.0' student (role student) posting in two 6.0 chats. One message from them in a 6.0 daily topic
--    before Monday would DM the admins while no task exists.
-- 3. The streak shown to students never resets. challenge_task_streak_current() counts the run that ENDS at the
--    student's latest on-time task. Days missed after that task are never counted, so a student on time Mon-Wed who
--    misses Thu and Fri still sees "🔥 3 kun ketma-ket". This shows on the Dashboard card, on /challenge/tasks and in
--    the 19:00 DM. Only the display is wrong; awarded streak XP comes from challenge_task_streak_recompute.
-- 4. The reconciler and the backfill use up the day's hint. challenge_task_capture() sets messages.hinted from
--    _found for no_slot, attempts_exhausted and wrong_group, whatever _src is. The held branch writes the once-a-day
--    'challenge_task_sender_held' row through challenge_task_note_once() for every source too. Only the bot
--    ('topic') ever sends a hint; reconcile_challenge_tasks calls capture + note_retry and nothing else. So when the
--    reconciler or backfill saw a message first, the student's real post later that day got no reply. The
--    reconciler also re-derives a held message for 26 hours, so yesterday's 23:55 post wrote a held row dated today
--    and inflated held_24h.today.
-- 8. my_challenge_tasks() skipped the checks that challenge_task_prepare_miniapp() applies: staff
--    (challenge_social_staff_ids()), status <> 'active', and archived_at. An admin, a teacher, or an archived
--    profile whose group_id is a 6.0 group would get the student Dashboard card ("0 kun ketma-ket · 0 ball"), and
--    then "Bu bo‘lim o‘quvchilar uchun" on the task page. Affected today: 0.
-- How many rows each problem has affected (production, 2026-10-01): 0 'challenge_task_sender_held' rows, 0 messages
-- with hinted = true (all 7 ledger rows are reconciler 'outside_window'), 0 approved tasks, and 0 staff, inactive or
-- archived profiles in a 6.0 group. Nothing needs repairing, so this file contains no backfill.
--
-- ═══ THE FIX (one pinned DO block; each function: live md5 pin -> asserted single-occurrence edits -> EXECUTE ->
-- stored == executed, owner / ACL / SECURITY DEFINER / search_path / volatility unchanged -> rewritten-body pin;
-- a function that already carries the '20261001070000' marker must be the pinned body, and is skipped) ═══
-- 1a challenge_task_is_task_day: the calendar now starts at the first APPROVED-OR-DRAFT task. A seeded weekday is a
--    task day, so the existing missing-task alerts cover week 1: the Sunday 18:00 DM (tick e, "Qoralama bor ..."),
--    the watchdog's no_task_tomorrow / no_task_today, and the 'no_task_today' row. Drafts still never post, score or
--    count toward a streak: only the alerts read this function. The self-test checks that challenge_tasks_health and
--    challenge_tasks_tick are its only readers, so a later reader cannot quietly start counting drafts.
-- 1b challenge_tasks_tick: a new section (e2), THE MORNING CHECK. From quiet_end (08:00) until post_time (09:00), if
--    today is a task day for a non-test course and has no approved task, it writes 'challenge_task_no_task_morning'
--    and sends a DM through the same challenge_tasks_admin_dm path as section (e). This happens once per course per
--    date. It is the last warning while approving can still get the 09:00 post out on time. A later approval still
--    posts on the same day, because tick (a) queues any task approved for today. The section has its own sub-block,
--    and a failure is recorded under 'morning' in the tick's failure memory, like every other section.
-- 2  challenge_tasks_watchdog: held_senders alarms only when today is a task day for some challenge course
--    (health.today.courses[].is_task_day), the same rule as the other calendar alarms. On a task day it still
--    alarms: a member whose profile sits in another course loses that day's work.
-- 3  challenge_task_streak_current: returns the CURRENT run. It is 0 once an approved task after the latest on-time
--    task is OVER without on-time work. OVER means the task's on-time day (Tashkent) has ended and no on-time
--    submission for it is still in progress (needs_more / checking with late_days = 0 can still become on-time
--    accepted), or the task is closed (challenge_task_close_at). This follows streak_recompute's rule: a day without
--    on-time accepted work ends the run. The awards themselves are unchanged (recompute is not touched).
-- 4  challenge_task_capture: only a 'topic' capture can mark a hint as sent (messages.hinted for no_slot,
--    attempts_exhausted and wrong_group), so the reconciler and backfill never hint and never use up the bot's
--    once-a-day hint. Held senders: the bot hints at most once a day, keyed on a TOPIC row only. The reconciler or
--    backfill writes a DB-visible held row only for a message posted TODAY, and only when no row exists yet. A
--    re-derived earlier message is not today's activity. Rows now carry details.source and details.hinted. The
--    advisory lock key is challenge_task_note_once's.
-- 8  my_challenge_tasks: {ok:false, reason:'staff'} for a staff member (checked first, as prepare_miniapp does) and
--    {ok:false, reason:'inactive'} for a challenge-group profile that is not 'active' or is archived. The live UI
--    already treats any non-ok reason as "hide the card / not in the challenge". The UI PR
--    (fix/daily-tasks-ui-pre-monday) adds dedicated handling for both reasons.
-- The edge half of this PR (no SQL): (5) a brand-new auto-registered poster whose post gets no receipt (no_slot /
-- comment) now gets the welcome line, inside the once-a-day hint or as one in-thread reply, and it is recorded as
-- 'challenge_task_welcome_delivered'; (6) the bot's registrar refuses 'left', 'kicked' and probe errors, the same as
-- the worker's (_shared/telegram-membership.ts membershipVerdict); (7) the group-poster identity lookup also matches
-- a chat by groups.daily_task_chat_id for the daily kind.
--
-- ═══ KILL-SWITCHES ═══ unchanged: platform_settings.challenge_tasks.enabled = false stops the tick, the alarms and the
-- capture; post / dm / receipts / remind as before. To silence only the new morning DM, set quiet_end at or after
-- post_time. (e2) runs only while quiet_end < post_time, so it is no extra switch.
-- ═══ DETECTION ═══ 'challenge_task_no_task_tomorrow' (Sunday 18:00, now also for a draft-only week 1),
-- 'challenge_task_no_task_morning' (new, 08:00), 'challenge_task_no_task_today', the watchdog's run rows,
-- 'challenge_task_sender_held' rows with details.source / hinted, 'challenge_task_welcome_delivered', and the
-- audit row 'challenge_tasks_pre_monday_applied'.
-- ═══ SELF-TEST ═══ Read-only. It never calls the tick, the watchdog, the capture or anything that sends, awards or
-- needs a JWT. It checks: markers and pins, the readers of is_task_day, is_task_day's answers around each
-- challenge course's first task date (STABLE, read-only), and the edited texts.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-pre-monday-check.ts (#218 + PR-1/2/3/6/5/9 +
-- the go-live, then THIS file, with the REAL tick, watchdog and capture on a pinned clock).
-- Merge: label migration-approved, NEVER ops-agent. Merge migration PRs one at a time, in timestamp order (after
-- 20261001030000 / 050010 / 060000 if those land first; none of them touches these six functions).

-- ═══════════════════════════════ 0. Prerequisites ═══════════════════════════════
do $$
begin
  if to_regprocedure('public.challenge_task_is_task_day(uuid, date, jsonb)') is null
     or to_regprocedure('public.challenge_task_streak_current(uuid, uuid)') is null
     or to_regprocedure('public.challenge_task_capture(jsonb, text, jsonb)') is null
     or to_regprocedure('public.my_challenge_tasks()') is null
     or to_regprocedure('public.challenge_tasks_watchdog(timestamptz)') is null
     or to_regprocedure('public.challenge_tasks_tick()') is null
     or to_regprocedure('public.challenge_tasks_admin_dm(text, text)') is null
     or to_regprocedure('public.challenge_task_close_at(public.challenge_tasks, jsonb)') is null
     or to_regprocedure('public.challenge_social_staff_ids()') is null
     or to_regprocedure('public.challenge_task_week_courses()') is null then
    raise exception 'ABORT: Daily Tasks PR-3 / PR-5 / PR-9 (20260930150020, 20260930152010, 20260930200010) must be applied first';
  end if;
end $$;

-- ═══════════════════════════════ 1. The pinned rewrites ═══════════════════════════════
do $mig$
declare
  r record;
  _fn regprocedure;
  _src text; _def text; _new text; _n int;
  _acl text[]; _owner oid; _secdef boolean; _pcfg text[]; _vol "char";
  _olds text[]; _news text[];
begin
  perform set_config('check_function_bodies', 'on', true);

  for r in
    select * from (values
      -- ── 1a: the calendar starts at the first approved-or-draft task ──
      ('challenge_task_is_task_day',
       'public.challenge_task_is_task_day(uuid, date, jsonb)',
       'baa7e4373d3143150dc06ad9de17c389',               -- live md5(replace(prosrc, CR, '')), read 2026-10-01
       '9ec36b8505cd4ce5333e2b6799bb9e7f',               -- the rewritten body (PGlite harness)
       array[
         array_to_string(array[
           $t$  -- C22 / G6: a date carrying an approved task (for _course, or any course when NULL), or a configured weekday ON OR$t$,
           $t$  -- AFTER the first approved task date (d4: the calendar starts at its first task -- Monday 2026-10-05 by the owner's$t$,
           $t$  -- decision -- so the weekdays before it never alarm), always inside the challenge window dates.$t$], E'\n') || E'\n',
         $t$                                   where t.status = 'approved' and (_course is null or t.course_id = _course)), 'infinity'::date)))$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$  -- C22 / G6: a date carrying an approved task (for _course, or any course when NULL), or a configured weekday ON OR$t$,
           $t$  -- AFTER the first task date (d4: the calendar starts at its first task -- Monday 2026-10-05 by the owner's decision$t$,
           $t$  -- -- so the weekdays before it never alarm), always inside the challenge window dates.$t$,
           $t$  -- 20261001070000: the calendar starts at the first APPROVED-OR-DRAFT task. It used to be the first APPROVED one, so$t$,
           $t$  -- a seeded week nobody approved was no task day at all and NOTHING alarmed (Monday simply posted nothing). Only the$t$,
           $t$  -- missing-task alerts read this function (challenge_tasks_tick (a) / (e) / (e2), challenge_tasks_health -> the$t$,
           $t$  -- watchdog's calendar alarms); posting, scoring and streaks read status = 'approved' themselves, so a draft still$t$,
           $t$  -- never posts or scores. 20261001070000's self-test asserts that set of readers.$t$], E'\n') || E'\n',
         $t$                                   where t.status in ('approved', 'draft') and (_course is null or t.course_id = _course)), 'infinity'::date)))$t$ || E'\n']),

      -- ── 3: the displayed streak is the CURRENT run ──
      ('challenge_task_streak_current',
       'public.challenge_task_streak_current(uuid, uuid)',
       'be2d9b3c0f58c6c0662467aeadf3b5ab',
       '3109b9e63ff26dbc531e487e8145d074',
       array[
         array_to_string(array[
           $t$  -- The display streak: consecutive approved task dates (rest days skipped) with an ON-TIME accepted submission,$t$,
           $t$  -- ending at the student's latest on-time task. Late work never counts.$t$,
           $t$  with t as ($t$,
           $t$    select x.task_date,$t$,
           $t$           exists (select 1 from public.challenge_task_submissions s$t$,
           $t$                    where s.user_id = _user and s.task_id = x.id and s.status = 'accepted' and s.late_days = 0) as done$t$,
           $t$      from public.challenge_tasks x$t$,
           $t$     where x.course_id = _course and x.status = 'approved'$t$,
           $t$  ),$t$,
           $t$  last_done as (select max(task_date) as d from t where done),$t$,
           $t$  last_miss as (select max(t.task_date) as d from t, last_done where not t.done and t.task_date < last_done.d)$t$,
           $t$  select coalesce((select count(*)::int from t, last_done, last_miss$t$,
           $t$                    where t.done and t.task_date <= last_done.d and (last_miss.d is null or t.task_date > last_miss.d)), 0)$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$  -- The display streak: consecutive approved task dates (rest days skipped) with an ON-TIME accepted submission,$t$,
           $t$  -- ending at the student's latest on-time task. Late work never counts.$t$,
           $t$  -- 20261001070000: and it is the CURRENT run -- 0 once an approved task AFTER that one is over without on-time work$t$,
           $t$  -- (it used to keep showing the old run forever). Over = its on-time day (Tashkent) has ended and no on-time$t$,
           $t$  -- submission of it is still in progress (needs_more / checking with late_days 0 may still be accepted on time),$t$,
           $t$  -- or it is closed (challenge_task_close_at). challenge_task_streak_recompute's rule: a task date without on-time$t$,
           $t$  -- accepted work ends the run. Display only: the awarded streak XP is recompute's alone.$t$,
           $t$  with c as (select public.challenge_tasks_config() as cfg),$t$,
           $t$  t as ($t$,
           $t$    select x.task_date,$t$,
           $t$           exists (select 1 from public.challenge_task_submissions s$t$,
           $t$                    where s.user_id = _user and s.task_id = x.id and s.status = 'accepted' and s.late_days = 0) as done,$t$,
           $t$           (now() >= public.challenge_task_close_at(x, c.cfg)$t$,
           $t$            or (x.task_date < public.challenge_task_local_date(now())$t$,
           $t$                and not exists (select 1 from public.challenge_task_submissions s$t$,
           $t$                                 where s.user_id = _user and s.task_id = x.id and s.status in ('needs_more', 'checking')$t$,
           $t$                                   and s.late_days = 0))) as over$t$,
           $t$      from public.challenge_tasks x, c$t$,
           $t$     where x.course_id = _course and x.status = 'approved'$t$,
           $t$  ),$t$,
           $t$  last_done as (select max(task_date) as d from t where done),$t$,
           $t$  last_miss as (select max(t.task_date) as d from t, last_done where not t.done and t.task_date < last_done.d)$t$,
           $t$  select case when exists (select 1 from t, last_done where not t.done and t.over and t.task_date > last_done.d) then 0$t$,
           $t$         else coalesce((select count(*)::int from t, last_done, last_miss$t$,
           $t$                         where t.done and t.task_date <= last_done.d and (last_miss.d is null or t.task_date > last_miss.d)), 0) end$t$], E'\n') || E'\n']),

      -- ── 4: only the bot ('topic') uses up the day's hint ──
      ('challenge_task_capture',
       'public.challenge_task_capture(jsonb, text, jsonb)',
       '226e33fb8a26cfd065bbd44fd3336366',
       '9102498405b411d2754f54072381e485',
       array[
         array_to_string(array[
           $t$    _found := public.challenge_task_note_once('challenge_task_sender_held', _p.id, jsonb_build_object($t$,
           $t$      'reason', _reason, 'tg_user_id', _from_id, 'chat_id', _chat, 'thread_id', _thread, 'message_id', _mid,$t$,
           $t$      'group_id', _topic.group_id, 'profile_group_id', _p.group_id));$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$    _found := not exists (select 1 from public.challenge_task_messages m$t$,
           $t$                           where m.user_id = _p.id and m.outcome = 'wrong_group' and m.hinted$t$], E'\n') || E'\n',
         $t$  _found := _outcome in ('no_slot', 'attempts_exhausted')$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$    -- 20261001070000: the once-a-day hint is the BOT's ('topic'). The reconciler and the backfill send none, so a$t$,
           $t$    -- row they write must never use up the day's hint, and their re-derivation of an EARLIER day's message is not$t$,
           $t$    -- today's activity (it inflated held_24h.today). Signal rows stay DB-visible: the bot's (hinted) at most once a$t$,
           $t$    -- day, else one from a same-day re-derivation when no row exists yet. Lock key = challenge_task_note_once's.$t$,
           $t$    perform pg_advisory_xact_lock(hashtext('ctask_once:challenge_task_sender_held:' || _p.id::text));$t$,
           $t$    _found := _src = 'topic'$t$,
           $t$              and not exists (select 1 from public.admin_actions a$t$,
           $t$                               where a.action = 'challenge_task_sender_held' and a.target_user_id = _p.id$t$,
           $t$                                 and a.created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent')$t$,
           $t$                                 and coalesce(a.details->>'source', 'topic') = 'topic');$t$,
           $t$    if _found$t$,
           $t$       or (_src <> 'topic' and _d = public.challenge_task_local_date(now())$t$,
           $t$           and not exists (select 1 from public.admin_actions a$t$,
           $t$                            where a.action = 'challenge_task_sender_held' and a.target_user_id = _p.id$t$,
           $t$                              and a.created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'))) then$t$,
           $t$      insert into public.admin_actions (actor_user_id, action, target_user_id, details)$t$,
           $t$      values (null, 'challenge_task_sender_held', _p.id, jsonb_build_object($t$,
           $t$        'reason', _reason, 'tg_user_id', _from_id, 'chat_id', _chat, 'thread_id', _thread, 'message_id', _mid,$t$,
           $t$        'group_id', _topic.group_id, 'profile_group_id', _p.group_id, 'source', _src, 'hinted', _found, 'at', now()));$t$,
           $t$    end if;$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$    -- 20261001070000: only the bot ('topic') sends hints, so only its row may mark one as sent$t$,
           $t$    _found := _src = 'topic' and not exists (select 1 from public.challenge_task_messages m$t$,
           $t$                           where m.user_id = _p.id and m.outcome = 'wrong_group' and m.hinted$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$  -- 20261001070000: only the bot ('topic') sends hints, so only its row may mark one as sent (a reconciler /$t$,
           $t$  -- backfill row marked hinted silenced that day's real hint)$t$,
           $t$  _found := _src = 'topic' and _outcome in ('no_slot', 'attempts_exhausted')$t$], E'\n') || E'\n']),

      -- ── 8: one "is a challenge student" rule for every view ──
      ('my_challenge_tasks',
       'public.my_challenge_tasks()',
       'fc71285882845e02332b6759a3187387',
       '372d8596416baa2b3730de2a5b3b6ac3',
       array[
         array_to_string(array[
           $t$  select t.group_id, t.course_id into _g$t$,
           $t$    from public.profiles p join public.challenge_task_topics() t on t.group_id = p.group_id$t$,
           $t$   where p.id = _uid;$t$,
           $t$  if not found then$t$,
           $t$    return jsonb_build_object('ok', false, 'reason', 'not_in_challenge');$t$,
           $t$  end if;$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$  -- 20261001070000: the SAME "is a challenge student" predicate as challenge_task_prepare_miniapp, so one rule decides$t$,
           $t$  -- it for every view (the Dashboard card hides on these reasons): staff never get the student card, and an archived$t$,
           $t$  -- or not-active profile is 'inactive'.$t$,
           $t$  if exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = _uid) then$t$,
           $t$    return jsonb_build_object('ok', false, 'reason', 'staff');$t$,
           $t$  end if;$t$,
           $t$  select t.group_id, t.course_id, p.status::text as status, p.archived_at into _g$t$,
           $t$    from public.profiles p join public.challenge_task_topics() t on t.group_id = p.group_id$t$,
           $t$   where p.id = _uid;$t$,
           $t$  if not found then$t$,
           $t$    return jsonb_build_object('ok', false, 'reason', 'not_in_challenge');$t$,
           $t$  end if;$t$,
           $t$  if _g.status <> 'active' or _g.archived_at is not null then$t$,
           $t$    return jsonb_build_object('ok', false, 'reason', 'inactive');$t$,
           $t$  end if;$t$], E'\n') || E'\n']),

      -- ── 2: held_senders on task days only ──
      ('challenge_tasks_watchdog',
       'public.challenge_tasks_watchdog(timestamptz)',
       '3bc7d4e73b1c3d0c2b959a7ae16e378c',               -- = 20260930200010's _new_pin, live 2026-10-01
       'd77e90e92da33377cd839772334f5b0c',
       array[
         $t$    if coalesce((_h#>>'{held_24h,today}')::int, 0) >= 1 then$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$    -- 20261001070000: TASK days only, like every calendar alarm (I10). Before the calendar starts, or on a rest$t$,
           $t$    -- day, a held member loses no task yet (a 5.0 student chatting in a 6.0 topic on a Thursday is no incident).$t$,
           $t$    if coalesce((_h#>>'{held_24h,today}')::int, 0) >= 1$t$,
           $t$       and exists (select 1 from jsonb_array_elements(coalesce(_h#>'{today,courses}', '[]'::jsonb)) x$t$,
           $t$                    where coalesce((x.value->>'is_task_day')::boolean, false)) then$t$], E'\n') || E'\n']),

      -- ── 1b: the 08:00 morning check ──
      ('challenge_tasks_tick',
       'public.challenge_tasks_tick()',
       '7e39fa98f564daa287960c045fac7fdb',
       '2c9da65b69eb53ea75315cde21c3526d',
       array[
         $t$  -- (f) THE SQL FALLBACK POSTER (w5). f1: settle the fallback's in-flight requests from pg_net's response table.$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$  -- (e2) 20261001070000: THE MORNING CHECK. From quiet_end (08:00) until post_time, today is a task day for a$t$,
           $t$  --      (non-test) course and still has no approved task -> 'challenge_task_no_task_morning' + admin DMs (the same$t$,
           $t$  --      path as (e)), once per course per date: the last call while approving still gets the post out on time$t$,
           $t$  --      (a later approval still posts the same day: (a) queues any task approved for today)$t$,
           $t$  if _lt >= _qe and _lt < _post then$t$,
           $t$    begin$t$,
           $t$      for _r in$t$,
           $t$        select g.course_id from public.challenge_task_topics() g group by g.course_id having bool_or(not g.is_test)$t$,
           $t$      loop$t$,
           $t$        continue when not public.challenge_task_is_task_day(_r.course_id, _today, _cfg);$t$,
           $t$        continue when exists (select 1 from public.challenge_tasks t$t$,
           $t$                               where t.course_id = _r.course_id and t.task_date = _today and t.status = 'approved');$t$,
           $t$        continue when exists (select 1 from public.admin_actions a$t$,
           $t$                               where a.action = 'challenge_task_no_task_morning' and a.created_at >= _day_start$t$,
           $t$                                 and a.details->>'course_id' = _r.course_id::text);$t$,
           $t$        _n := (select count(*)::int from public.challenge_tasks t$t$,
           $t$                where t.course_id = _r.course_id and t.task_date = _today and t.status = 'draft');$t$,
           $t$        _txt := '⏰ Kunlik vazifalar: bugungi (' || extract(day from _today)::int::text || '-'$t$,
           $t$             || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from _today)::int]$t$,
           $t$             || ', ' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from _today)::int]$t$,
           $t$             || ') vazifa hali TASDIQLANMAGAN'$t$,
           $t$             || coalesce(' — «' || (select c.title from public.courses c where c.id = _r.course_id) || '»', '')$t$,
           $t$             || case when _n > 0 then '. Qoralama bor: Admin → Kunlik vazifalar → «Tasdiqlash».'$t$,
           $t$                     else '. Kalendarda vazifa yo‘q: Admin → Kunlik vazifalar.' end$t$,
           $t$             || E'\n' || to_char(_post, 'HH24:MI') || ' gacha tasdiqlang — keyin tasdiqlansa, vazifa guruhlarga kechikib chiqadi.'$t$,
           $t$             || E'\nhttps://www.aicreator.academy/admin/challenge/tasks?week=' || to_char(date_trunc('week', _today::timestamp), 'YYYY-MM-DD');$t$,
           $t$        _dm := public.challenge_tasks_admin_dm(_txt, 'challenge-tasks-morning-check');$t$,
           $t$        insert into public.admin_actions (actor_user_id, action, details)$t$,
           $t$        values (null, 'challenge_task_no_task_morning', jsonb_build_object('course_id', _r.course_id, 'date', _today,$t$,
           $t$                'drafts', _n, 'dm_sent', _dm, 'at', now()));$t$,
           $t$        _out := _out || jsonb_build_object('no_task_morning', true);$t$,
           $t$      end loop;$t$,
           $t$    exception when others then$t$,
           $t$      _err := _err || jsonb_build_object('morning', left(sqlerrm, 200));$t$,
           $t$    end;$t$,
           $t$  end if;$t$,
           $t$$t$,
           $t$  -- (f) THE SQL FALLBACK POSTER (w5). f1: settle the fallback's in-flight requests from pg_net's response table.$t$], E'\n') || E'\n'])
    ) v(name, sig, pin, new_pin, olds, news)
  loop
    _fn := to_regprocedure(r.sig);
    if _fn is null then
      raise exception 'ABORT: % not found', r.sig;
    end if;
    select prosrc, array(select x::text from unnest(proacl) x order by 1), proowner, prosecdef, proconfig, provolatile
      into _src, _acl, _owner, _secdef, _pcfg, _vol
      from pg_proc where oid = _fn;

    if position('20261001070000' in _src) > 0 then             -- replay: the marker exists only after this rewrite
      if md5(replace(_src, E'\r', '')) <> r.new_pin then
        raise exception 'ABORT: % carries the 20261001070000 marker but not the harness-verified body (md5 %)', r.name,
          md5(replace(_src, E'\r', ''));
      end if;
      raise notice '% already rewritten -- skipped', r.name;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified on 2026-10-01 (md5 %); re-read the live definition and regenerate this migration',
        r.name, md5(replace(_src, E'\r', ''));
    end if;

    _olds := r.olds;
    _news := r.news;
    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_olds, 1) loop
      _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration', r.name, i, _n;
      end if;
      _new := replace(_new, _olds[i], _news[i]);
    end loop;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', r.name;
    end if;
    if (select array(select x::text from unnest(proacl) x order by 1) from pg_proc where oid = _fn) is distinct from _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef
       or (select proconfig from pg_proc where oid = _fn) is distinct from _pcfg
       or (select provolatile from pg_proc where oid = _fn) <> _vol then
      raise exception 'ABORT: % -- owner, ACL, SECURITY DEFINER, search_path or volatility changed', r.name;
    end if;
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> r.new_pin then
      raise exception 'ABORT: % -- the rewritten body is not the harness-verified one (md5 %)', r.name,
        (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
    end if;
  end loop;
end $mig$;

-- ═══════════════════════════════ 2. Self-test (read-only) + audit once ═══════════════════════════════
-- Never calls the tick, the watchdog, the capture, my_challenge_tasks (it needs a JWT) or anything that sends,
-- awards or writes; is_task_day is STABLE and only reads.
do $mig$
declare
  _bad text[] := '{}';
  _src text;
  _readers text[];
  _cfg jsonb := public.challenge_tasks_config();
  _c uuid;
  _d0 date;
  _d date;
  _days jsonb := '{}'::jsonb;
begin
  -- (a) the drafts-count rule stays an ALERT rule: only the alert readers call is_task_day
  select coalesce(array_agg(p.proname::text order by p.proname), '{}') into _readers
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname <> 'challenge_task_is_task_day'
     and p.prosrc like '%challenge_task_is_task_day%';
  if _readers <> array['challenge_tasks_health', 'challenge_tasks_tick']::text[] then
    _bad := _bad || ('is_task_day_readers:' || array_to_string(_readers, '|'));
  end if;
  -- (b) is_task_day around each challenge course's first approved-or-draft date: never before it, and the first date
  --     itself is a task day when it is a configured weekday inside the window (the week-1 case)
  foreach _c in array public.challenge_task_week_courses() loop
    select min(t.task_date) into _d0 from public.challenge_tasks t where t.course_id = _c and t.status in ('approved', 'draft');
    continue when _d0 is null;
    for _d in select generate_series(_d0 - 7, _d0 - 1, interval '1 day')::date loop
      if public.challenge_task_is_task_day(_c, _d, _cfg) then
        _bad := _bad || ('task_day_before_start:' || _c || ':' || _d);
      end if;
    end loop;
    if extract(isodow from _d0)::int in (select (x #>> '{}')::int
                                           from jsonb_array_elements(coalesce(_cfg->'task_weekdays', '[1,2,3,4,5]'::jsonb)) x)
       and (_cfg->>'w_start_date' is null or _d0 >= (_cfg->>'w_start_date')::date)
       and (_cfg->>'w_end_date' is null or _d0 <= (_cfg->>'w_end_date')::date)
       and not public.challenge_task_is_task_day(_c, _d0, _cfg) then
      _bad := _bad || ('first_date_not_task_day:' || _c || ':' || _d0);
    end if;
    _days := _days || jsonb_build_object(_c::text, jsonb_build_object('first', _d0,
               'is_task_day', public.challenge_task_is_task_day(_c, _d0, _cfg)));
  end loop;
  -- (c) the edited texts are the ones that landed
  _src := (select prosrc from pg_proc where oid = 'public.challenge_task_capture(jsonb, text, jsonb)'::regprocedure);
  if position('challenge_task_note_once(''challenge_task_sender_held''' in _src) > 0
     or (length(_src) - length(replace(_src, '20261001070000', ''))) / length('20261001070000') <> 3
     or position('_found := _src = ''topic'' and _outcome in (''no_slot'', ''attempts_exhausted'')' in _src) = 0 then
    _bad := _bad || 'capture_text'::text;
  end if;
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_tick()'::regprocedure);
  if position('''challenge_task_no_task_morning''' in _src) = 0
     or position('public.challenge_tasks_admin_dm(_txt, ''challenge-tasks-morning-check'')' in _src) = 0
     or (length(_src) - length(replace(_src, 'public.ops_net_post(', ''))) / length('public.ops_net_post(') <> 2 then
    _bad := _bad || 'tick_text'::text;
  end if;
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure);
  if position('where coalesce((x.value->>''is_task_day'')::boolean, false)) then' in _src) = 0
     or position('challenge_task_week_approval_health' in _src) = 0 then
    _bad := _bad || 'watchdog_text'::text;
  end if;
  _src := (select prosrc from pg_proc where oid = 'public.my_challenge_tasks()'::regprocedure);
  if position('''reason'', ''staff''' in _src) = 0 or position('''reason'', ''inactive''' in _src) = 0 then
    _bad := _bad || 'my_challenge_tasks_text'::text;
  end if;
  -- (d) still not reachable by anon (authenticated keeps my_challenge_tasks only; ACLs were asserted unchanged above)
  if has_function_privilege('anon', 'public.my_challenge_tasks()', 'EXECUTE')
     or has_function_privilege('anon', 'public.challenge_task_streak_current(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.challenge_task_streak_current(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.challenge_task_capture(jsonb, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.challenge_task_is_task_day(uuid, date, jsonb)', 'EXECUTE') then
    _bad := _bad || 'acl'::text;
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: 20261001070000 self-test failed: %', array_to_string(_bad, ', ');
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'challenge_tasks_pre_monday_applied', jsonb_build_object(
           'migration', '20261001070000',
           'functions', (select jsonb_object_agg(p.oid::regprocedure::text, md5(replace(p.prosrc, E'\r', '')))
                           from pg_proc p
                          where p.oid in ('public.challenge_task_is_task_day(uuid, date, jsonb)'::regprocedure,
                                          'public.challenge_task_streak_current(uuid, uuid)'::regprocedure,
                                          'public.challenge_task_capture(jsonb, text, jsonb)'::regprocedure,
                                          'public.my_challenge_tasks()'::regprocedure,
                                          'public.challenge_tasks_watchdog(timestamptz)'::regprocedure,
                                          'public.challenge_tasks_tick()'::regprocedure)),
           'calendar_start', _days,
           'is_task_day_readers', to_jsonb(_readers),
           'at', now())
   where not exists (select 1 from public.admin_actions where action = 'challenge_tasks_pre_monday_applied');
end $mig$;
