-- Harden the anon-leaking per-user SECURITY DEFINER RPCs (class fix; audit run
-- 2026-08-20 against 20 candidate functions — see anon-leak-audit.md).
--
-- The class: every function below is a per-user "reader" RPC (self/teacher/leaderboard/
-- homework stats) that is directly EXECUTE-able by the `anon` Postgres role via PostgREST,
-- and falls into one of two leak shapes:
--   (A) guard used the `auth.uid() is null` anti-pattern as an allow branch. Anon's
--       auth.uid() IS null too, so this accidentally let any anonymous caller who could
--       guess/enumerate a target uuid straight through. (7 functions: admin_homework_health,
--       admin_teacher_engagement_health, teacher_group_top, teacher_groups,
--       teacher_leaderboard, teacher_weekly_self, teacher_xp.)
--   (B) no caller-identity guard at all, or the guard checked has_role() on the untrusted
--       PARAMETER instead of the real caller (homework_pending_count_for_user,
--       get_visible_student_ids) — either way anon (or any authenticated user) could pass an
--       arbitrary uuid and read that person's/group's private stats, names, and scores.
--       (12 functions: current_group_star, daily_goal_progress, group_leaderboard,
--       leaderboard_group_window, leaderboard_my_rank, leaderboard_my_rank_for_user,
--       leaderboard_top_for_user, user_course_xp, user_homework_avg10_effective,
--       homework_pending_count_for_user, had_genuine_activity_on_date,
--       get_visible_student_ids.)
--
-- Guard idiom applied (matches the already-shipped precedent
-- 20260813102934_secure_profile_stats_and_award_helpers.sql and today's sibling
-- 20260820090000_harden_group_analytics_rpcs.sql): a caller is allowed iff they are the
-- subject themselves (auth.uid() = the target uuid), staff (has_role admin/superadmin, or
-- teacher where the function already scoped that way), or the trusted backend
-- (auth.role() = 'service_role' — NEVER `auth.uid() is null`, because anon's uid is null too).
-- get_visible_student_ids uses the CASE-based identity resolution already shipped for
-- admin_group_engagement_stats: trust the _scope_user_id parameter ONLY when the caller is
-- service_role, otherwise always use the caller's own auth.uid().
--
-- ONE deliberate exception: user_homework_avg10_effective(uuid, integer) is called in bulk by
-- the pg_cron job `recalc-leaderboard` (`*/15 * * * *`, a bare `SELECT
-- public.recalc_leaderboard();`) which carries NO PostgREST request context at all — both
-- auth.uid() and auth.role() come back NULL there (verified against auth.uid()/auth.role()'s
-- actual source: current_setting('request.jwt.claim.sub'/'role', true)). A genuine anonymous
-- HTTP call through PostgREST always carries role='anon' (Supabase requires an apikey on every
-- REST call), so "no JWT context at all" is a real, non-spoofable signal meaning "direct-SQL /
-- pg_cron / nested SECURITY DEFINER call" — never reachable from the internet. Its guard is
-- therefore `(auth.role() = 'service_role' OR auth.role() IS NULL OR self OR staff)`. This
-- `IS NULL` branch is added to NO other function in this migration — every other internal
-- caller either runs in an authenticated admin session (auth.uid() propagates through nested
-- SECURITY DEFINER calls) or is a service_role edge function/webhook.
--
-- public_profile(uuid) (audit #19) was found SAFE — its existing guard already has no anon
-- shortcut and returns zero rows to anon. It gets defense-in-depth ONLY: a `service_role`
-- branch added to its guard (so a future backend caller doesn't silently get empty rows) paired
-- with the same anon revoke as every other function below — never one without the other.
--
-- Every added/changed guard only NARROWS who may call successfully; no stat query, join, CTE,
-- or return shape was touched, and the change is a pure CREATE OR REPLACE (idempotent) +
-- grant-lockdown migration — no schema or data change.
--
-- Untouched on purpose (RLS-used, must stay anon-executable): has_role, is_group_teacher,
-- is_teacher_of.

-- ============================================================================
-- 1. admin_homework_health() — Group A: drop `auth.uid() is null` in the `ok` CTE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_homework_health()
 RETURNS TABLE(group_id uuid, group_name text, course_name text, teacher_name text, students integer, active_7d integer, submissions_total integer, pending integer, graded_pct integer, median_wait_days numeric, avg_score numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select (has_role(auth.uid(),'admin'::app_role) or has_role(auth.uid(),'superadmin'::app_role)
            or auth.role() = 'service_role') as allowed
  ),
  g as (
    select g.id, g.name, c.title course, tp.name tname
    from groups g
    left join courses c on c.id = g.course_id
    left join profiles tp on tp.id = g.teacher_id
    where (select allowed from ok)
  ),
  mem as (
    select p.group_id gid, p.id sid from profiles p
    where p.status='active' and p.archived_at is null and p.group_id is not null
  ),
  subs as (
    select m.gid, hs.score, hs.score_is_stale, hs.submitted_at, hs.scored_at
    from homework_submissions hs join mem m on m.sid = hs.user_id
  )
  select g.id, g.name, g.course, coalesce(g.tname,'—'),
    (select count(*)::int from mem where gid = g.id),
    (select count(distinct d.user_id)::int from daily_watch_summary d join mem m2 on m2.sid = d.user_id
      where m2.gid = g.id and d.watch_date > current_date - 7),
    (select count(*)::int from subs where gid = g.id),
    (select count(*)::int from subs where gid = g.id and (score is null or score_is_stale)),
    coalesce((select round(count(*) filter (where score is not null and not coalesce(score_is_stale,false)) * 100.0
              / nullif(count(*),0))::int from subs where gid = g.id), 0),
    (select round((percentile_cont(0.5) within group (order by extract(epoch from (scored_at - submitted_at))/86400.0))::numeric, 1)
      from subs where gid = g.id and scored_at is not null),
    (select round(avg(score)::numeric, 1) from subs where gid = g.id and score is not null)
  from g order by g.course, g.name;
$function$;

-- ============================================================================
-- 2. admin_teacher_engagement_health(integer) — Group A: drop `auth.uid() is null` in final WHERE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_teacher_engagement_health(p_days integer DEFAULT 14)
 RETURNS TABLE(active_teachers integer, xp_grade integer, xp_ontime integer, xp_answer integer, xp_impact integer, xp_queueclear integer, xp_activeday integer, ontime_pct numeric, feedback_pct numeric, top_pct numeric, nudges_sent integer, optout_teachers integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with w as (select (now() - make_interval(days => p_days)) as f),
  xp as (
    select
      count(distinct user_id) filter (where reason like 'teacher_%')::int as active_teachers,
      coalesce(sum(amount) filter (where reason = 'teacher_grade'), 0)::int as xp_grade,
      coalesce(sum(amount) filter (where reason = 'teacher_grade_ontime'), 0)::int as xp_ontime,
      coalesce(sum(amount) filter (where reason = 'teacher_answer'), 0)::int as xp_answer,
      coalesce(sum(amount) filter (where reason = 'teacher_impact'), 0)::int as xp_impact,
      coalesce(sum(amount) filter (where reason = 'teacher_queue_clear'), 0)::int as xp_queueclear,
      coalesce(sum(amount) filter (where reason = 'teacher_active_day'), 0)::int as xp_activeday
    from xp_events, w where created_at >= w.f
  ),
  grading as (
    select
      round((100.0 * count(*) filter (where hs.scored_at - hs.submitted_at <= interval '24 hours') / nullif(count(*), 0))::numeric, 0) as ontime_pct,
      round((100.0 * count(*) filter (where btrim(coalesce(hs.score_feedback, '')) <> '') / nullif(count(*), 0))::numeric, 0) as feedback_pct,
      round((100.0 * count(*) filter (where hs.score = ha.max_score) / nullif(count(*), 0))::numeric, 0) as top_pct
    from homework_submissions hs join homework_assignments ha on ha.id = hs.assignment_id, w
    where hs.scored_at >= w.f and hs.score is not null and hs.submitted_at is not null
      and hs.scored_by in (select user_id from user_roles where role = 'teacher'::app_role)
  ),
  nudges as (
    select count(*)::int as nudges_sent from notifications_log, w
    where notification_type in ('teacher_waiting', 'teacher_offline') and sent_at >= w.f
  ),
  optout as (
    select count(*)::int as optout_teachers
    from profiles p join user_roles ur on ur.user_id = p.id and ur.role = 'teacher'::app_role
    where p.notifications_enabled = false
  )
  select xp.active_teachers, xp.xp_grade, xp.xp_ontime, xp.xp_answer, xp.xp_impact, xp.xp_queueclear, xp.xp_activeday,
    grading.ontime_pct, grading.feedback_pct, grading.top_pct, nudges.nudges_sent, optout.optout_teachers
  from xp, grading, nudges, optout
  where has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role) or auth.role() = 'service_role';
$function$;

-- ============================================================================
-- 3. teacher_group_top(uuid, uuid, integer) — Group A: drop `auth.uid() is null` in `ok` CTE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.teacher_group_top(uid uuid, _group_id uuid, _limit integer DEFAULT 5)
 RETURNS TABLE(rank integer, first_name text, last_initial text, total_xp integer, level integer, current_streak integer, completed_lessons integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select exists(
      select 1 from groups g
      where g.id = _group_id
        and (g.teacher_id = uid or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role))
    ) and (auth.role() = 'service_role' or auth.uid() = uid
           or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = _group_id and p.status = 'active' and p.archived_at is null
      and (select allowed from ok)
  ),
  ranked as (
    select m.id, m.name, m.last_name,
           coalesce(x.total_xp, 0) txp, coalesce(x.level, 1) lvl, coalesce(s.current_streak, 0) streak,
           row_number() over (order by coalesce(x.total_xp,0) desc, coalesce(s.current_streak,0) desc, m.id) r
    from members m
    left join user_xp x on x.user_id = m.id
    left join streaks s on s.user_id = m.id
  )
  select r.r::int, coalesce(nullif(r.name,''),'Talaba'), coalesce(left(nullif(r.last_name,''),1),''),
         r.txp, r.lvl, r.streak,
         (select count(*)::int from lesson_progress lp where lp.user_id = r.id and lp.completed_at is not null)
  from ranked r
  order by r.r
  limit _limit;
$function$;

-- ============================================================================
-- 4. teacher_groups(uuid) — Group A: drop `auth.uid() is null` in `ok` CTE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.teacher_groups(uid uuid)
 RETURNS TABLE(group_id uuid, group_name text, course_name text, total_students integer, active_7d integer, avg_completion_pct integer, pending_homework integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select (auth.role() = 'service_role' or auth.uid() = uid
            or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  gs as (
    select g.id, g.name, g.course_id, c.title as course_name
    from groups g
    left join courses c on c.id = g.course_id
    where g.id in (select public.teacher_group_ids(uid)) and (select allowed from ok)
  ),
  members as (
    select p.id as student_id, p.group_id
    from profiles p
    join gs on gs.id = p.group_id
    where p.status = 'active' and p.archived_at is null
  ),
  course_lessons as (
    select gs.id as gid, count(l.id) as n
    from gs
    join modules m on m.course_id = gs.course_id
    join lessons l on l.module_id = m.id
    group by gs.id
  ),
  done as (
    select mem.group_id as gid, mem.student_id, count(lp.lesson_id) as n_done
    from members mem
    left join lesson_progress lp
      on lp.user_id = mem.student_id and lp.completed_at is not null
      and lp.lesson_id in (
        select l.id from lessons l join modules m on m.id = l.module_id
        where m.course_id = (select course_id from gs where gs.id = mem.group_id)
      )
    group by mem.group_id, mem.student_id
  ),
  act as (
    select mem.group_id as gid, count(distinct mem.student_id) as n
    from members mem
    join daily_watch_summary d on d.user_id = mem.student_id
      and d.watch_date > current_date - 7
    group by mem.group_id
  ),
  pend as (
    select mem.group_id as gid, count(*) as n
    from homework_submissions hs
    join members mem on mem.student_id = hs.user_id
    where hs.score is null
    group by mem.group_id
  )
  select gs.id, gs.name, gs.course_name,
         (select count(*)::int from members where group_id = gs.id),
         coalesce((select n from act where gid = gs.id), 0)::int,
         coalesce((select round(avg(d.n_done * 100.0 / nullif(cl.n, 0)))::int
                   from done d join course_lessons cl on cl.gid = gs.id
                   where d.gid = gs.id), 0),
         coalesce((select n from pend where gid = gs.id), 0)::int
  from gs
  order by gs.name;
$function$;

-- ============================================================================
-- 5. teacher_leaderboard(uuid, integer) — Group A: drop `auth.uid() is null` in `ok` CTE.
--    (Rest of the guard intentionally still lets any teacher see the whole leaderboard.)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.teacher_leaderboard(uid uuid, _limit integer DEFAULT 30)
 RETURNS TABLE(rank integer, prev_rank integer, teacher_id uuid, first_name text, last_initial text, week_xp integer, prev_week_xp integer, is_me boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select (auth.role() = 'service_role' or has_role(auth.uid(), 'teacher'::app_role)
            or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  bounds as (
    select
      (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent') as ws
  ),
  win as (
    select ws, (ws - interval '7 days') as ls from bounds
  ),
  teachers as (
    select ur.user_id as tid from user_roles ur where ur.role = 'teacher'::app_role
  ),
  wk as (
    select e.user_id as tid,
      coalesce(sum(e.amount) filter (where e.created_at >= (select ws from win)), 0)::int as week_xp,
      coalesce(sum(e.amount) filter (where e.created_at >= (select ls from win) and e.created_at < (select ws from win)), 0)::int as prev_week_xp
    from xp_events e
    where e.reason like 'teacher_%' and e.created_at >= (select ls from win)
    group by e.user_id
  ),
  ranked as (
    select t.tid,
      coalesce(w.week_xp, 0) as week_xp,
      coalesce(w.prev_week_xp, 0) as prev_week_xp,
      row_number() over (order by coalesce(w.week_xp, 0) desc, t.tid) as r,
      row_number() over (order by coalesce(w.prev_week_xp, 0) desc, t.tid) as prev_r
    from teachers t left join wk w on w.tid = t.tid
  )
  select r.r::int, r.prev_r::int, r.tid,
    coalesce(nullif(p.name, ''), 'Ustoz'), coalesce(left(nullif(p.last_name, ''), 1), ''),
    r.week_xp, r.prev_week_xp, (r.tid = uid)
  from ranked r
  join profiles p on p.id = r.tid
  where (select allowed from ok)
  order by r.r
  limit _limit;
$function$;

-- ============================================================================
-- 6. teacher_weekly_self(uuid, integer) — Group A: drop `auth.uid() is null` in the RAISE guard.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.teacher_weekly_self(uid uuid, p_days integer DEFAULT 7)
 RETURNS TABLE(graded integer, grading_med_min numeric, on_time_pct numeric, ungraded_backlog integer, oldest_pending_hours numeric, feedback_rate numeric, avg_score_pct numeric, questions integer, answered integer, answer_rate numeric, median_wait_min numeric, active_days integer, days_window integer, week_messages integer, last_active timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  _from timestamptz := now() - make_interval(days => p_days);
  _tgid bigint;
begin
  if not (auth.role() = 'service_role' or auth.uid() = uid
          or has_role(auth.uid(), 'admin'::app_role)
          or has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'not allowed';
  end if;

  select p.telegram_id into _tgid from profiles p where p.id = uid;

  return query
  with
  staff_ids as (
    select distinct ur.user_id as sid from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  my_groups as (
    select g.id as gid from groups g where g.teacher_id = uid
  ),
  -- grading YOU did in the window + turnaround / on-time / quality signals
  grading as (
    select
      count(*)::int as graded,
      round(percentile_cont(0.5) within group (
        order by extract(epoch from (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) as grading_med_min,
      round((100.0 * count(*) filter (
        where hs.scored_at - hs.submitted_at <= interval '24 hours') / nullif(count(*), 0))::numeric, 0) as on_time_pct,
      round((100.0 * count(*) filter (
        where btrim(coalesce(hs.score_feedback, '')) <> '') / nullif(count(*), 0))::numeric, 0) as feedback_rate,
      round(avg(100.0 * hs.score / nullif(ha.max_score, 0))::numeric, 0) as avg_score_pct
    from homework_submissions hs
    join homework_assignments ha on ha.id = hs.assignment_id
    where hs.scored_by = uid and hs.scored_at >= _from
      and hs.submitted_at is not null and hs.score is not null
  ),
  -- current backlog waiting on this teacher's groups
  backlog as (
    select count(*)::int as ungraded_backlog,
      round((extract(epoch from (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) as oldest_pending_hours
    from homework_submissions hs
    join profiles pr on pr.id = hs.user_id
    join my_groups mg on mg.gid = pr.group_id
    where hs.score is null and hs.submitted_at is not null
  ),
  -- directed student questions in this teacher's groups
  dq as (
    select gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from group_message_events gme
    join my_groups mg on mg.gid = gme.group_id
    where gme.sent_at >= _from
      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and _tgid is not null and gme.reply_to_user_id = _tgid))
  ),
  dq_ans as (
    select dq.q_at,
      (select min(a.sent_at) from group_message_events a
        where a.telegram_chat_id = dq.chat and a.telegram_thread_id = dq.thread
          and a.sent_at > dq.q_at and a.profile_id in (select sid from staff_ids)) as a_at
    from dq
  ),
  q_agg as (
    select count(*)::int as questions,
      count(*) filter (where a_at is not null)::int as answered,
      round(percentile_cont(0.5) within group (order by extract(epoch from (a_at - q_at)) / 60.0)
            filter (where a_at is not null)::numeric, 1) as median_wait_min
    from dq_ans
  ),
  -- this teacher's own messages in their groups (anon-admin OR own named account)
  acts as (
    select (e.sent_at at time zone 'Asia/Tashkent')::date as d, e.sent_at
    from group_message_events e
    join my_groups mg on mg.gid = e.group_id
    where e.sent_at >= _from
      and (e.is_anon_admin or (_tgid is not null and e.telegram_user_id = _tgid))
  ),
  act_agg as (
    select count(distinct d)::int as active_days, count(*)::int as week_messages from acts
  ),
  lastact as (select max(sent_at) as last_active from acts)
  select
    coalesce(g.graded, 0)::int, g.grading_med_min, g.on_time_pct,
    coalesce(b.ungraded_backlog, 0)::int, b.oldest_pending_hours,
    g.feedback_rate, g.avg_score_pct,
    coalesce(q.questions, 0)::int, coalesce(q.answered, 0)::int,
    (case when coalesce(q.questions, 0) > 0 then round(100.0 * q.answered / q.questions, 0) else null end)::numeric,
    q.median_wait_min,
    coalesce(a.active_days, 0)::int, p_days::int, coalesce(a.week_messages, 0)::int,
    la.last_active
  from grading g
  cross join backlog b
  cross join q_agg q
  cross join act_agg a
  cross join lastact la;
end;
$function$;

-- ============================================================================
-- 7. teacher_xp(uuid) — Group A: drop `auth.uid() is null` in WHERE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.teacher_xp(uid uuid)
 RETURNS TABLE(total_xp integer, level integer, xp_next_level integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(x.total_xp, 0), coalesce(x.level, 1),
         public.xp_threshold_for(coalesce(x.level, 1))
  from (select 1) _
  left join public.user_xp x on x.user_id = uid
  where (auth.role() = 'service_role' or auth.uid() = uid
         or public.has_role(auth.uid(), 'admin'::app_role)
         or public.has_role(auth.uid(), 'superadmin'::app_role));
$function$;

-- ============================================================================
-- 8. current_group_star(uuid) — no guard existed; AND a self/staff/service_role guard into WHERE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.current_group_star(uid uuid)
 RETURNS TABLE(first_name text, last_initial text, is_me boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE(NULLIF(p.name,''),'Talaba'),
    COALESCE(LEFT(NULLIF(p.last_name,''),1),''),
    (wgs.user_id = uid)
  FROM weekly_group_star wgs
  JOIN profiles p ON p.id = wgs.user_id
  WHERE wgs.group_id = (SELECT group_id FROM profiles WHERE id = uid)
    AND wgs.week_start = (date_trunc('week', (now() AT TIME ZONE 'Asia/Tashkent'))::date)
    AND (auth.role() = 'service_role' OR uid = auth.uid()
         OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role))
  LIMIT 1;
$function$;

-- ============================================================================
-- 9. daily_goal_progress(uuid) — no guard, no top-level FROM; add FROM (SELECT 1) _ WHERE (guard).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.daily_goal_progress(uid uuid)
 RETURNS TABLE(target integer, done integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE((SELECT g.target FROM user_daily_goal g WHERE g.user_id = uid), 1),
    COALESCE((
      SELECT COUNT(DISTINCT lp.lesson_id)::int
      FROM lesson_progress lp
      WHERE lp.user_id = uid
        AND (
          (lp.completed_at IS NOT NULL AND lp.completed_at::date = (now() AT TIME ZONE 'Asia/Tashkent')::date)
          OR (lp.updated_at::date = (now() AT TIME ZONE 'Asia/Tashkent')::date AND COALESCE(lp.watch_seconds_total,0) >= 30)
        )
    ), 0)
  FROM (SELECT 1) _
  WHERE (auth.role() = 'service_role' OR uid = auth.uid()
         OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role));
$function$;

-- ============================================================================
-- 10. group_leaderboard(uuid, integer) — no guard; add `ok` CTE, gate `members`.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.group_leaderboard(uid uuid, _limit integer DEFAULT 20)
 RETURNS TABLE(rank integer, user_id uuid, first_name text, last_initial text, total_xp integer, level integer, current_streak integer, is_me boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select (auth.role() = 'service_role' or uid = auth.uid()
            or public.has_role(auth.uid(),'admin'::app_role) or public.has_role(auth.uid(),'superadmin'::app_role)) as allowed
  ),
  my as (
    select p.group_id as gid,
           (select g.course_id from groups g where g.id = p.group_id) as cid
    from profiles p where p.id = uid
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = (select gid from my)
      and p.group_id is not null
      and p.status = 'active' and p.archived_at is null
      and (select allowed from ok)
  ),
  scored as (
    select m.id as uid2, m.name, m.last_name,
      case when (select cid from my) is null
           then coalesce((select x.total_xp from user_xp x where x.user_id = m.id), 0)
           else public.user_group_rating_xp(m.id, (select cid from my)) end as score,
      coalesce((select x.level from user_xp x where x.user_id = m.id), 1) as lvl,
      coalesce((select s.current_streak from streaks s where s.user_id = m.id), 0) as streak
    from members m
  ),
  ranked as (
    select scored.*, row_number() over (order by score desc, streak desc, uid2) as r
    from scored
  )
  select ranked.r::int, ranked.uid2,
         coalesce(nullif(ranked.name, ''), 'Talaba'),
         coalesce(left(nullif(ranked.last_name, ''), 1), ''),
         ranked.score::int, ranked.lvl, ranked.streak,
         (ranked.uid2 = uid)
  from ranked
  order by ranked.r
  limit _limit;
$function$;

-- ============================================================================
-- 11. leaderboard_group_window(uuid, integer) — no guard; add `ok` CTE, gate `members`.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.leaderboard_group_window(uid uuid, _around integer DEFAULT 2)
 RETURNS TABLE(group_rank integer, user_id uuid, first_name text, last_initial text, score integer, is_me boolean, group_total integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ok AS (
    SELECT (auth.role() = 'service_role' OR uid = auth.uid()
            OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role)) AS allowed
  ),
  members AS (
    SELECT p.id,
           COALESCE(NULLIF(p.name,''), 'Talaba') AS first_name,
           COALESCE(LEFT(NULLIF(p.last_name,''),1), '') AS last_initial,
           COALESCE(lc.score, 0) AS score,
           ROW_NUMBER() OVER (ORDER BY COALESCE(lc.score,0) DESC, COALESCE(lc.lessons_30d,0) DESC) AS grank
    FROM profiles p
    LEFT JOIN leaderboard_cache lc ON lc.user_id = p.id
    WHERE p.group_id = (SELECT group_id FROM profiles WHERE id = uid)
      AND p.group_id IS NOT NULL
      AND p.status = 'active'
      AND p.archived_at IS NULL
      AND (SELECT allowed FROM ok)
  ),
  me AS (SELECT grank FROM members WHERE id = uid),
  total AS (SELECT COUNT(*)::int AS c FROM members)
  SELECT m.grank::int, m.id, m.first_name, m.last_initial, m.score::int,
         (m.id = uid), (SELECT c FROM total)
  FROM members m, me
  WHERE m.grank BETWEEN me.grank - _around AND me.grank + _around
  ORDER BY m.grank;
$function$;

-- ============================================================================
-- 12. leaderboard_my_rank(uuid) — no guard, no top-level FROM (dead caller); add
--     FROM (SELECT 1) _ WHERE (guard).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.leaderboard_my_rank(uid uuid)
 RETURNS TABLE(rank integer, total integer, score integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (SELECT rank FROM leaderboard_cache WHERE user_id = uid),
    (SELECT COUNT(*)::int FROM leaderboard_cache),
    (SELECT score FROM leaderboard_cache WHERE user_id = uid)
  FROM (SELECT 1) _
  WHERE (auth.role() = 'service_role' OR uid = auth.uid()
         OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role));
$function$;

-- ============================================================================
-- 13. leaderboard_my_rank_for_user(uuid) — no guard, no top-level FROM (dead caller); add
--     `ok` CTE, terminal FROM ok WHERE ok.allowed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.leaderboard_my_rank_for_user(uid uuid)
 RETURNS TABLE(rank integer, total integer, score integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ok AS (
    SELECT (auth.role() = 'service_role' OR uid = auth.uid()
            OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role)) AS allowed
  ),
  my_course AS (
    SELECT COALESCE(
      (SELECT g.course_id FROM profiles p JOIN groups g ON g.id = p.group_id WHERE p.id = uid),
      (SELECT e.course_id FROM enrollments e WHERE e.user_id = uid ORDER BY e.enrolled_at LIMIT 1)
    ) AS course_id
  ),
  course_members AS (
    SELECT DISTINCT p.id
    FROM profiles p
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.status = 'active' AND p.archived_at IS NULL
      AND (
        g.course_id = (SELECT course_id FROM my_course)
        OR (g.course_id IS NULL AND EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.user_id = p.id AND e.course_id = (SELECT course_id FROM my_course)))
      )
  ),
  ranked AS (
    SELECT lc.user_id, lc.score,
           ROW_NUMBER() OVER (ORDER BY lc.score DESC, lc.lessons_30d DESC, lc.current_streak DESC) AS r
    FROM leaderboard_cache lc
    JOIN course_members cm ON cm.id = lc.user_id
  )
  SELECT
    (SELECT r::int FROM ranked WHERE user_id = uid),
    (SELECT COUNT(*)::int FROM ranked),
    (SELECT score FROM ranked WHERE user_id = uid)
  FROM ok WHERE ok.allowed;
$function$;

-- ============================================================================
-- 14. leaderboard_top_for_user(uuid, integer) — no guard, dead caller; add `ok` CTE,
--     AND into the final WHERE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.leaderboard_top_for_user(uid uuid, _limit integer DEFAULT 10)
 RETURNS TABLE(rank integer, user_id uuid, first_name text, last_initial text, score integer, current_streak integer, lessons_30d integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ok AS (
    SELECT (auth.role() = 'service_role' OR uid = auth.uid()
            OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role)) AS allowed
  ),
  my_course AS (
    SELECT COALESCE(
      (SELECT g.course_id FROM profiles p JOIN groups g ON g.id = p.group_id WHERE p.id = uid),
      (SELECT e.course_id FROM enrollments e WHERE e.user_id = uid ORDER BY e.enrolled_at LIMIT 1)
    ) AS course_id
  ),
  course_members AS (
    SELECT DISTINCT p.id
    FROM profiles p
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.status = 'active' AND p.archived_at IS NULL
      AND (
        g.course_id = (SELECT course_id FROM my_course)
        OR (g.course_id IS NULL AND EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.user_id = p.id AND e.course_id = (SELECT course_id FROM my_course)))
      )
  ),
  ranked AS (
    SELECT lc.user_id, lc.score, lc.current_streak, lc.lessons_30d,
           ROW_NUMBER() OVER (ORDER BY lc.score DESC, lc.lessons_30d DESC, lc.current_streak DESC) AS r
    FROM leaderboard_cache lc
    JOIN course_members cm ON cm.id = lc.user_id
  )
  SELECT ranked.r::int AS rank, ranked.user_id,
         COALESCE(NULLIF(p.name,''), 'Talaba') AS first_name,
         COALESCE(LEFT(NULLIF(p.last_name,''),1), '') AS last_initial,
         ranked.score, ranked.current_streak, ranked.lessons_30d
  FROM ranked
  JOIN profiles p ON p.id = ranked.user_id
  WHERE (SELECT course_id FROM my_course) IS NOT NULL
    AND (SELECT allowed FROM ok)
  ORDER BY ranked.r
  LIMIT _limit;
$function$;

-- ============================================================================
-- 15. user_course_xp(uuid, uuid) — no guard; AND into the existing WHERE.
--     (Internal caller admin_course_group_stats propagates the real admin's auth.uid()
--     through the nested SECURITY DEFINER call, so its has_role(auth.uid(),'admin') branch
--     covers it automatically — no special-casing needed.)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.user_course_xp(_uid uuid, _course_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(ev.amount), 0)::int
  from (
    select e.amount, e.reason, split_part(e.ref_key, ':', 2)::uuid as rid
    from xp_events e
    where e.user_id = _uid
      and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
  ) ev
  where _course_id is not null
    and (
      (ev.reason = 'lesson_complete' and exists (
        select 1 from lessons l join modules m on m.id = l.module_id
        where l.id = ev.rid and m.course_id = _course_id))
      or (ev.reason in ('homework_submit', 'homework_high_score') and exists (
        select 1 from homework_assignments a join modules m on m.id = a.module_id
        where a.id = ev.rid and m.course_id = _course_id))
    )
    and (auth.role() = 'service_role' or _uid = auth.uid()
         or public.has_role(auth.uid(),'admin'::app_role) or public.has_role(auth.uid(),'superadmin'::app_role));
$function$;

-- ============================================================================
-- 16. user_homework_avg10_effective(uuid, integer) — no guard; AND into the existing WHERE.
--     ⚠ Deliberate exception (see header): the pg_cron job `recalc-leaderboard` (bare SELECT,
--     no request context) calls this in bulk every 15 minutes, and a bare direct-SQL call has
--     auth.role() = NULL, not 'service_role'. The `auth.role() IS NULL` branch keeps that job
--     working; it is NOT added to any other function in this migration.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.user_homework_avg10_effective(p_user_id uuid, p_within_days integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH active AS (
    SELECT id, parent_id, max_score FROM homework_assignments WHERE COALESCE(is_active, true) = true
  ),
  parents_with_sap AS (SELECT DISTINCT parent_id FROM active WHERE parent_id IS NOT NULL),
  leaves AS (
    SELECT a.id, a.max_score FROM active a
    WHERE a.parent_id IS NOT NULL OR a.id NOT IN (SELECT parent_id FROM parents_with_sap)
  ),
  eff AS (
    SELECT l.max_score,
      COALESCE(hs.score,
        (SELECT (e->>'score')::numeric
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL AND (e->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
         ORDER BY ord DESC LIMIT 1)) AS effective_score,
      COALESCE(hs.scored_at,
        (SELECT (e->>'scored_at')::timestamptz
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL ORDER BY ord DESC LIMIT 1)) AS effective_scored_at
    FROM leaves l JOIN homework_submissions hs ON hs.assignment_id = l.id AND hs.user_id = p_user_id
  )
  SELECT CASE WHEN COALESCE(SUM(max_score),0) = 0 THEN NULL
              ELSE ROUND((SUM(effective_score) / SUM(max_score)) * 10, 1) END
  FROM eff
  WHERE effective_score IS NOT NULL
    AND (p_within_days IS NULL OR effective_scored_at >= now() - make_interval(days => p_within_days))
    AND (
      auth.role() = 'service_role' OR auth.role() IS NULL
      OR p_user_id = auth.uid()
      OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role)
    );
$function$;

-- ============================================================================
-- 17. homework_pending_count_for_user(uuid) — checked has_role() on the untrusted PARAMETER,
--     never the real caller. Add a real caller-identity guard; leave the existing
--     has_role(_uid, …) scoping logic alone (that decides WHAT scope to count, the new
--     check decides WHO may ask).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.homework_pending_count_for_user(_uid uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n int;
BEGIN
  IF NOT (auth.role() = 'service_role' OR auth.uid() = _uid
          OR has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF has_role(_uid,'admin'::app_role) THEN
    SELECT COUNT(*) INTO n FROM homework_submissions WHERE score IS NULL;
  ELSIF has_role(_uid,'teacher'::app_role) THEN
    SELECT COUNT(*) INTO n
      FROM homework_submissions s
      JOIN profiles p ON p.id = s.user_id
      JOIN groups g ON g.id = p.group_id
     WHERE s.score IS NULL AND g.id IN (SELECT public.teacher_group_ids(_uid));
  ELSE n := 0;
  END IF;
  RETURN COALESCE(n, 0);
END;
$function$;

-- ============================================================================
-- 18. had_genuine_activity_on_date(uuid, date) — no guard, dead caller; AND the guard onto
--     the boolean result (a predicate, not a row-source — an unauthorized caller gets `false`,
--     not an error, matching the function's existing all-boolean contract).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.had_genuine_activity_on_date(p_user_id uuid, p_date date DEFAULT ((now() AT TIME ZONE 'Asia/Tashkent'::text))::date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (auth.role() = 'service_role' OR p_user_id = auth.uid()
     OR public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role))
    AND (
      EXISTS (  -- (a1) genuinely watched a lesson that day (per-day watch rollup)
        SELECT 1 FROM public.daily_watch_summary d
        WHERE d.user_id = p_user_id AND d.watch_date = p_date
          AND COALESCE(d.total_seconds, 0) >= 30
      )
      OR EXISTS (  -- (a2) completed a lesson that day
        SELECT 1 FROM public.lesson_progress lp
        WHERE lp.user_id = p_user_id
          AND lp.completed_at IS NOT NULL
          AND (lp.completed_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
      )
      OR EXISTS (  -- (b) posted in a group module topic that day
        SELECT 1 FROM public.group_message_events g
        WHERE g.profile_id = p_user_id
          AND g.telegram_thread_id IS NOT NULL
          AND (g.sent_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
      )
      OR EXISTS (  -- (c) submitted homework that day
        SELECT 1 FROM public.homework_submissions h
        WHERE h.user_id = p_user_id
          AND (h.submitted_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
      )
    );
$function$;

-- ============================================================================
-- 19. public_profile(uuid) — SAFE (already gated, anon gets zero rows). Defense-in-depth
--     ONLY: add a `service_role` branch to the existing guard (paired with the anon revoke
--     below, so a future backend caller doesn't silently get empty rows once anon is revoked).
--     No other logic changed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.public_profile(_uid uuid)
 RETURNS TABLE(user_id uuid, first_name text, last_initial text, avatar_url text, bio text, group_name text, teacher_name text, level integer, total_xp integer, current_streak integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id,
         coalesce(nullif(p.name,''), 'Talaba'),
         coalesce(left(nullif(p.last_name,''),1), ''),
         p.avatar_url, p.bio,
         g.name,
         coalesce(nullif(tp.name,''), null),
         coalesce(x.level, 1), coalesce(x.total_xp, 0),
         coalesce(s.current_streak, 0)
  from profiles p
  left join groups g on g.id = p.group_id
  left join profiles tp on tp.id = g.teacher_id
  left join user_xp x on x.user_id = p.id
  left join streaks s on s.user_id = p.id
  where p.id = _uid
    and (
      _uid = auth.uid()
      or auth.role() = 'service_role'
      or public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'superadmin')
      or public.has_role(auth.uid(), 'teacher')
      or (p.group_id is not null and p.group_id = (select p3.group_id from profiles p3 where p3.id = auth.uid()))
    );
$function$;

-- ============================================================================
-- 20. get_visible_student_ids(uuid) — the untrusted parameter could override the caller's
--     identity via COALESCE(_scope_user_id, auth.uid()). Same CASE pattern already shipped
--     today in 20260820090000_harden_group_analytics_rpcs.sql: trust the parameter only from
--     service_role, otherwise always use the caller's own auth.uid().
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_visible_student_ids(_scope_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid;
BEGIN
  uid := CASE
    WHEN auth.uid() IS NOT NULL THEN auth.uid()
    WHEN auth.role() = 'service_role' THEN _scope_user_id
    ELSE NULL
  END;

  IF uid IS NULL THEN
    RETURN;
  END IF;

  IF public.has_role(uid, 'admin'::app_role) THEN
    RETURN QUERY
      SELECT p.id
      FROM public.profiles p
      WHERE NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role
      );
    RETURN;
  END IF;

  IF public.has_role(uid, 'teacher'::app_role) THEN
    RETURN QUERY
      SELECT p.id
      FROM public.profiles p
      WHERE p.group_id IN (SELECT public.teacher_group_ids(uid))
        AND NOT EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role
        );
    RETURN;
  END IF;

  RETURN;
END;
$function$;

-- ============================================================================
-- Grant lockdown: remove the blanket PUBLIC + explicit anon grants on all 20 functions
-- (the 19 hardened above + public_profile); keep the legitimate callers (authenticated =
-- frontend sessions, service_role = edge functions / webhook / pg_cron-adjacent jobs).
-- ============================================================================
REVOKE ALL ON FUNCTION public.admin_homework_health() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_teacher_engagement_health(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_group_top(uuid, uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_groups(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_leaderboard(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_weekly_self(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_xp(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_group_star(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.daily_goal_progress(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.group_leaderboard(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leaderboard_group_window(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leaderboard_my_rank(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leaderboard_my_rank_for_user(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leaderboard_top_for_user(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_course_xp(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_homework_avg10_effective(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homework_pending_count_for_user(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.had_genuine_activity_on_date(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.public_profile(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_visible_student_ids(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_homework_health() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_teacher_engagement_health(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_group_top(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_groups(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_leaderboard(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_weekly_self(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_xp(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_group_star(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.daily_goal_progress(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.group_leaderboard(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_group_window(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_my_rank(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_my_rank_for_user(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leaderboard_top_for_user(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_course_xp(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_homework_avg10_effective(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.homework_pending_count_for_user(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.had_genuine_activity_on_date(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_profile(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_visible_student_ids(uuid) TO authenticated, service_role;
