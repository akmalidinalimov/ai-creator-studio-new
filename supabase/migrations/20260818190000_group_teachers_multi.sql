-- Feature 2 — Multiple teachers per group (DB stage A).
--
-- "Teachers of a group" = groups.teacher_id (PRIMARY, kept as-is for teacher-XP, student-facing
-- "your teacher", analytics/digest RPCs) UNION public.group_teachers.teacher_id (co-teachers).
-- Any of a group's teachers may grade, receive the submission DM, and see their group.
--
-- This migration ONLY changes the grading/visibility/notification engine's teachership TEST. It does
-- NOT touch teacher-XP (award_teacher_engagement_xp, xp_on_student_module_impact), the scalar
-- teacher_name on public_profile/profile_stats, or the digest/nudge/analytics RPCs — those keep
-- reading the primary groups.teacher_id for v1 (documented deferral in the spec).
--
-- The webhook fan-out (teacherGroups()/notifyTeachersOfSubmission) and the admin multi-assign UI are
-- SEPARATE stages (B, C) — NOT here.
--
-- Idempotent: create table if not exists, create or replace for every function, drop-if-exists before
-- each policy create, on-conflict-do-nothing backfill.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1) Junction table
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.group_teachers (
  group_id   uuid not null references public.groups(id) on delete cascade,
  teacher_id uuid not null references auth.users(id)   on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (group_id, teacher_id)
);
create index if not exists group_teachers_teacher_idx on public.group_teachers(teacher_id);

alter table public.group_teachers enable row level security;

-- Admins manage all.
drop policy if exists "gt admin all" on public.group_teachers;
create policy "gt admin all" on public.group_teachers
  for all to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2) Two canonical helpers (SECURITY DEFINER, set search_path=public) — built BEFORE the rewrites so
--    every rewritten function/policy can call them. Read groups + group_teachers as owner (both tables
--    are admin-only under RLS; the definer is exactly why can_see_group/is_teacher_of are definer too).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.is_group_teacher(_group_id uuid, _uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.groups g where g.id = _group_id and g.teacher_id = _uid)
      or exists (select 1 from public.group_teachers gt where gt.group_id = _group_id and gt.teacher_id = _uid);
$$;
revoke execute on function public.is_group_teacher(uuid, uuid) from public, anon;
grant execute on function public.is_group_teacher(uuid, uuid) to authenticated, service_role;

create or replace function public.teacher_group_ids(_uid uuid)
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select id from public.groups where teacher_id = _uid
  union
  select group_id from public.group_teachers where teacher_id = _uid;
$$;
revoke execute on function public.teacher_group_ids(uuid) from public, anon;
grant execute on function public.teacher_group_ids(uuid) to authenticated, service_role;

-- A teacher may SELECT junction rows for groups they teach (uses the definer helper → no RLS recursion
-- on group_teachers, since is_group_teacher reads it as owner).
drop policy if exists "gt teacher read own" on public.group_teachers;
create policy "gt teacher read own" on public.group_teachers
  for select to authenticated
  using (
    has_role(auth.uid(), 'teacher'::app_role)
    and public.is_group_teacher(group_teachers.group_id, auth.uid())
  );

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 3) Backfill (heal history, idempotent): every group with a non-null primary teacher gets a
--    group_teachers row (is_primary=true). groups.teacher_id stays populated (it IS the primary).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
insert into public.group_teachers (group_id, teacher_id, is_primary)
select g.id, g.teacher_id, true
from public.groups g
where g.teacher_id is not null
on conflict (group_id, teacher_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 4) Grading / visibility function rewrites — each copied VERBATIM from its latest live definition,
--    with ONLY the teachership test swapped to the helper. Source migration cited above each.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- 4.1 is_teacher_of  (src: 20260706200000_fix_teacher_homework_rls.sql:12)
--     g.teacher_id = _teacher  →  public.is_group_teacher(p.group_id, _teacher)
--     (this alone junction-fixes the "hws own select/update" homework_submissions RLS policies).
create or replace function public.is_teacher_of(_student uuid, _teacher uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p join groups g on g.id = p.group_id
    where p.id = _student and public.is_group_teacher(p.group_id, _teacher)
  )
$$;
revoke execute on function public.is_teacher_of(uuid, uuid) from public, anon;
grant execute on function public.is_teacher_of(uuid, uuid) to authenticated;

-- 4.2 can_see_group  (src: 20260502225517_1ffcf65a-...sql:27)
--     EXISTS(groups g WHERE g.id=_group_id AND g.teacher_id=_uid)  →  public.is_group_teacher(_group_id,_uid)
CREATE OR REPLACE FUNCTION public.can_see_group(_group_id uuid, _uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT
    public.has_role(_uid,'admin'::app_role)
    OR public.is_group_teacher(_group_id, _uid);
$function$;

-- 4.3 get_visible_student_ids  (src: 20260502222025_520feec3-...sql:4)
--     teacher branch group filter: p.group_id IN (SELECT g.id FROM groups g WHERE g.teacher_id=uid)
--                                → p.group_id IN (SELECT public.teacher_group_ids(uid))
CREATE OR REPLACE FUNCTION public.get_visible_student_ids(_scope_user_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := COALESCE(_scope_user_id, auth.uid());
BEGIN
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
$$;
REVOKE ALL ON FUNCTION public.get_visible_student_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visible_student_ids(uuid) TO authenticated, service_role;

-- 4.4 homework_pending_count_for_user  (src: 20260502233427_7dfb0139-...sql:124)
--     teacher branch: g.teacher_id = _uid  →  g.id IN (SELECT public.teacher_group_ids(_uid))
CREATE OR REPLACE FUNCTION public.homework_pending_count_for_user(_uid uuid)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
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
$$;

-- 4.5 teacher_groups  (src: 20260706100000_teacher_profile_support.sql:6)
--     gs CTE: where g.teacher_id = uid  →  where g.id in (select public.teacher_group_ids(uid))
create or replace function public.teacher_groups(uid uuid)
returns table(
  group_id uuid, group_name text, course_name text,
  total_students int, active_7d int, avg_completion_pct int, pending_homework int
)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (auth.uid() is null or auth.uid() = uid
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
$$;
grant execute on function public.teacher_groups(uuid) to authenticated;

-- 4.6 teacher_group_statistics — TWO live overloads. The Forbidden gate must let a co-teacher through.

-- 4.6a two-arg overload  (src: 20260506091525_8cb6eb96-...sql:1)
--     gate: NOT v_is_admin AND (v_teacher IS NULL OR v_teacher <> v_caller)
--        →  NOT (v_is_admin OR public.is_group_teacher(p_group_id, v_caller))
--     (uses v_caller = COALESCE(auth.uid(), p_caller_profile_id), preserving this overload's caller
--      resolution so a co-teacher passed via p_caller_profile_id also passes.)
CREATE OR REPLACE FUNCTION public.teacher_group_statistics(p_group_id uuid, p_caller_profile_id uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_is_admin boolean;
  v_teacher uuid;
  v_group_name text;
  v_total_students int;
  v_today int;
  v_msg_7d int;
  v_msg_30d int;
  v_active_today int;
  v_active_7d int;
  v_active_30d int;
  v_pending int;
  v_avg numeric;
  v_tz constant text := 'Asia/Tashkent';
BEGIN
  v_caller := COALESCE(auth.uid(), p_caller_profile_id);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  v_is_admin := has_role(v_caller, 'admin'::app_role);
  SELECT teacher_id, name INTO v_teacher, v_group_name FROM public.groups WHERE id = p_group_id;
  IF v_group_name IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;
  IF NOT (v_is_admin OR public.is_group_teacher(p_group_id, v_caller)) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total_students
  FROM public.profiles
  WHERE group_id = p_group_id AND status = 'active';

  SELECT count(*) INTO v_today FROM public.group_message_events
   WHERE group_id = p_group_id
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(*) INTO v_msg_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '7 days';
  SELECT count(*) INTO v_msg_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '30 days';

  SELECT count(DISTINCT profile_id) INTO v_active_today FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(DISTINCT profile_id) INTO v_active_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '7 days';
  SELECT count(DISTINCT profile_id) INTO v_active_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '30 days';

  SELECT count(*) INTO v_pending
  FROM public.homework_submissions hs
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NULL;

  SELECT round(avg(CASE WHEN ha.max_score > 0 THEN 10.0 * hs.score / ha.max_score END)::numeric, 1)
  INTO v_avg
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NOT NULL AND ha.max_score > 0;

  RETURN json_build_object(
    'group_name', v_group_name,
    'total_students', v_total_students,
    'messages', json_build_object(
      'today', v_today,
      'last_7d', v_msg_7d,
      'last_30d', v_msg_30d
    ),
    'active_students', json_build_object(
      'today', v_active_today,
      'last_7d', v_active_7d,
      'last_30d', v_active_30d
    ),
    'pending_homework_count', v_pending,
    'avg_module_score', v_avg,
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid, uuid) TO authenticated, service_role;

-- 4.6b single-arg overload  (src: 20260506084919_f3a14d6f-...sql:39) — still live (never dropped).
--     gate: NOT v_is_admin AND v_teacher IS DISTINCT FROM auth.uid()
--        →  NOT (v_is_admin OR public.is_group_teacher(p_group_id, auth.uid()))
CREATE OR REPLACE FUNCTION public.teacher_group_statistics(p_group_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_teacher uuid;
  v_group_name text;
  v_total_students int;
  v_today int;
  v_yesterday int;
  v_msg_7d int;
  v_msg_30d int;
  v_active_today int;
  v_active_7d int;
  v_active_30d int;
  v_silent_count int;
  v_silent_names jsonb;
  v_top jsonb;
  v_pending int;
  v_avg numeric;
  v_today_pct numeric;
  v_tz constant text := 'Asia/Tashkent';
BEGIN
  v_is_admin := has_role(auth.uid(), 'admin'::app_role);
  SELECT teacher_id, name INTO v_teacher, v_group_name FROM public.groups WHERE id = p_group_id;
  IF v_group_name IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;
  IF NOT (v_is_admin OR public.is_group_teacher(p_group_id, auth.uid())) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total_students
  FROM public.profiles
  WHERE group_id = p_group_id AND status = 'active';

  -- Messages
  SELECT count(*) INTO v_today FROM public.group_message_events
   WHERE group_id = p_group_id
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(*) INTO v_yesterday FROM public.group_message_events
   WHERE group_id = p_group_id
     AND sent_at >= (date_trunc('day', (now() AT TIME ZONE v_tz)) - interval '1 day') AT TIME ZONE v_tz
     AND sent_at <  date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(*) INTO v_msg_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '7 days';
  SELECT count(*) INTO v_msg_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '30 days';

  IF v_yesterday > 0 THEN
    v_today_pct := round(100.0 * (v_today - v_yesterday)::numeric / v_yesterday, 0);
  ELSE
    v_today_pct := NULL;
  END IF;

  -- Active students
  SELECT count(DISTINCT profile_id) INTO v_active_today FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(DISTINCT profile_id) INTO v_active_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL AND sent_at >= now() - interval '7 days';
  SELECT count(DISTINCT profile_id) INTO v_active_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL AND sent_at >= now() - interval '30 days';

  -- Silent students (active profile, no message in 7d)
  WITH active_ids AS (
    SELECT DISTINCT profile_id FROM public.group_message_events
     WHERE group_id = p_group_id AND profile_id IS NOT NULL
       AND sent_at >= now() - interval '7 days'
  ),
  silent AS (
    SELECT p.id, p.name, p.last_name
    FROM public.profiles p
    WHERE p.group_id = p_group_id
      AND p.status = 'active'
      AND p.id NOT IN (SELECT profile_id FROM active_ids WHERE profile_id IS NOT NULL)
  )
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object('name', name, 'last_name', last_name)
                            ORDER BY name NULLS LAST) FILTER (WHERE rn <= 5), '[]'::jsonb)
  INTO v_silent_count, v_silent_names
  FROM (SELECT s.*, row_number() OVER (ORDER BY name NULLS LAST) AS rn FROM silent s) x;

  -- Top contributors 7d
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', p.name, 'last_name', p.last_name, 'message_count', mc
         ) ORDER BY mc DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT profile_id, count(*) AS mc
    FROM public.group_message_events
    WHERE group_id = p_group_id AND profile_id IS NOT NULL
      AND sent_at >= now() - interval '7 days'
    GROUP BY profile_id
    ORDER BY mc DESC
    LIMIT 3
  ) m
  JOIN public.profiles p ON p.id = m.profile_id;

  -- Pending homework count for students in this group
  SELECT count(*) INTO v_pending
  FROM public.homework_submissions hs
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NULL;

  -- Average graded score (percent of max)
  SELECT round(avg(100.0 * hs.score::numeric / NULLIF(ha.max_score,0))::numeric, 1)
    INTO v_avg
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NOT NULL;

  RETURN jsonb_build_object(
    'group_name', v_group_name,
    'total_students', v_total_students,
    'messages', jsonb_build_object(
      'today', v_today,
      'yesterday', v_yesterday,
      'last_7d', v_msg_7d,
      'last_30d', v_msg_30d,
      'today_vs_yesterday_pct', v_today_pct
    ),
    'active_students', jsonb_build_object(
      'today', v_active_today,
      'today_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_today / v_total_students) ELSE 0 END,
      'last_7d', v_active_7d,
      'last_7d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_7d / v_total_students) ELSE 0 END,
      'last_30d', v_active_30d,
      'last_30d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_30d / v_total_students) ELSE 0 END
    ),
    'silent_students_7d', jsonb_build_object('count', v_silent_count, 'names', v_silent_names),
    'top_contributors_7d', v_top,
    'pending_homework_count', v_pending,
    'avg_module_score', v_avg,
    'generated_at', now()
  )::json;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid) TO authenticated;

-- 4.7 group_student_leaderboard  (src: 20260810205006_group_student_leaderboard.sql:45)
--     ok CTE: or exists (select 1 from groups g where g.id=_group_id and g.teacher_id=auth.uid())
--          →  or public.is_group_teacher(_group_id, auth.uid())
create or replace function public.group_student_leaderboard(_group_id uuid, _limit int default 10)
returns table(board text, rank int, user_id uuid, first_name text, last_initial text,
              xp int, level int, current_streak int)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (auth.uid() is null
            or has_role(auth.uid(), 'admin'::app_role)
            or has_role(auth.uid(), 'superadmin'::app_role)
            or public.is_group_teacher(_group_id, auth.uid())
           ) as allowed
  ),
  ctx as (
    select g.course_id as cid,
           -- Monday 00:00 in Tashkent, back to a timestamptz for the created_at comparison.
           (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent') as weekstart
    from groups g
    where g.id = _group_id and (select allowed from ok)
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = _group_id
      and p.status = 'active' and p.archived_at is null
      and (select allowed from ok)
  ),
  scored as (
    select m.id, m.name, m.last_name,
      -- Same primitive the /leaderboard page + profile header rank use → numbers match everywhere.
      public.user_group_rating_xp(m.id, (select cid from ctx)) as alltime_xp,
      public.user_group_rating_xp_since(m.id, (select cid from ctx), (select weekstart from ctx)) as weekly_xp,
      coalesce((select x.level from user_xp x where x.user_id = m.id), 1) as lvl,
      coalesce((select s.current_streak from streaks s where s.user_id = m.id), 0) as streak
    from members m
  ),
  alltime as (
    select 'alltime'::text as board,
      row_number() over (order by alltime_xp desc, streak desc, id) as r,
      id, name, last_name, alltime_xp as xp, lvl, streak
    from scored
  ),
  weekly as (
    select 'weekly'::text as board,
      row_number() over (order by weekly_xp desc, streak desc, id) as r,
      id, name, last_name, weekly_xp as xp, lvl, streak
    from scored
    where weekly_xp > 0   -- only students who actually earned XP this week appear as "champions"
  )
  select u.board, u.r::int, u.id,
         coalesce(nullif(u.name, ''), 'Talaba'),
         coalesce(left(nullif(u.last_name, ''), 1), ''),
         u.xp::int, u.lvl, u.streak
  from (
    select * from alltime where r <= _limit
    union all
    select * from weekly where r <= _limit
  ) u
  order by u.board, u.r;
$$;
revoke execute on function public.group_student_leaderboard(uuid, int) from public, anon;
grant execute on function public.group_student_leaderboard(uuid, int) to authenticated, service_role;

-- 4.8 teacher_profile_stats  (src: 20260813102934_secure_profile_stats_and_award_helpers.sql:104)
--     groups_count:   count(groups where teacher_id=uid)        → count(public.teacher_group_ids(uid))
--     students_total: profiles..groups where g.teacher_id=uid   → g.id in (select public.teacher_group_ids(uid))
--     graded_total / avg_score_given (scored_by) + the auth.role() guard: UNCHANGED.
create or replace function public.teacher_profile_stats(uid uuid)
returns table(groups_count integer, students_total integer, graded_total integer, avg_score_given numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::int from public.teacher_group_ids(uid) as gid),
    (select count(*)::int from profiles p join groups g on g.id = p.group_id
      where g.id in (select public.teacher_group_ids(uid)) and p.status = 'active' and p.archived_at is null),
    (select count(*)::int from homework_submissions hs where hs.scored_by = uid and hs.score is not null),
    (select round(avg(hs.score)::numeric, 1) from homework_submissions hs
      where hs.scored_by = uid and hs.score is not null)
  where (auth.role() = 'service_role' or auth.uid() = uid
         or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role));
$$;
revoke execute on function public.teacher_profile_stats(uuid) from public, anon;
grant execute on function public.teacher_profile_stats(uuid) to authenticated, service_role;

-- 4.9 start_homework_resubmission  (src: 20260705150000_resubmission_teacher_scope.sql:6)
--     inline teacher check: g.teacher_id = v_caller  →  public.is_group_teacher(st.group_id, v_caller)
CREATE OR REPLACE FUNCTION public.start_homework_resubmission(p_submission_id uuid)
 RETURNS homework_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.homework_submissions;
  v_caller uuid := auth.uid();
  v_role text := auth.role();
  v_snapshot jsonb;
BEGIN
  SELECT * INTO v_row FROM public.homework_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_found';
  END IF;

  IF v_role IS DISTINCT FROM 'service_role' THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'not_authenticated';
    END IF;
    -- Allowed: the student themselves, an admin/superadmin, or a teacher who
    -- teaches the student's group. A teacher NOT assigned to the group is denied.
    IF v_caller <> v_row.user_id
       AND NOT public.has_role(v_caller, 'admin'::app_role)
       AND NOT public.has_role(v_caller, 'superadmin'::app_role)
       AND NOT (
         public.has_role(v_caller, 'teacher'::app_role)
         AND EXISTS (
           SELECT 1 FROM public.profiles st
           JOIN public.groups g ON g.id = st.group_id
           WHERE st.id = v_row.user_id AND public.is_group_teacher(st.group_id, v_caller)
         )
       ) THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  END IF;

  IF v_row.score IS NULL THEN
    UPDATE public.homework_submissions
       SET attempt_number = COALESCE(attempt_number, 1) + 1,
           is_late = false,
           submitted_at = now(),
           updated_at = now(),
           score_is_stale = false
     WHERE id = p_submission_id
     RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  v_snapshot := jsonb_build_object(
    'attempt_number', v_row.attempt_number,
    'score', v_row.score,
    'score_feedback', v_row.score_feedback,
    'scored_by', v_row.scored_by,
    'scored_at', v_row.scored_at,
    'submitted_at', v_row.submitted_at,
    'telegram_message_url', v_row.telegram_message_url,
    'is_late', v_row.is_late
  );

  UPDATE public.homework_submissions
     SET attempt_number = COALESCE(attempt_number, 1) + 1,
         previous_attempts = COALESCE(previous_attempts, '[]'::jsonb) || v_snapshot,
         score_is_stale = true,
         is_late = false,
         submitted_at = now(),
         updated_at = now()
   WHERE id = p_submission_id
   RETURNING * INTO v_row;

  BEGIN
    INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after, db_user)
    VALUES ('homework_submissions', 'RESUBMIT', v_row.user_id, v_row.id, v_snapshot, to_jsonb(v_row), current_user);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_row;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 5) Inline RLS policies made junction-aware (drop + recreate; keep the has_role teacher gate, swap
--    the EXISTS(groups...) teachership for the helper).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- 5.1 group_message_events "gme teacher read own groups"  (src: 20260506084919_f3a14d6f-...sql:27)
drop policy if exists "gme teacher read own groups" on public.group_message_events;
create policy "gme teacher read own groups"
  on public.group_message_events for select
  to authenticated
  using (
    has_role(auth.uid(), 'teacher'::app_role)
    and public.is_group_teacher(group_message_events.group_id, auth.uid())
  );

-- 5.2 group_module_topics "gmt teacher read own groups"  (src: 20260503204701_a5617103-...sql:54)
drop policy if exists "gmt teacher read own groups" on public.group_module_topics;
create policy "gmt teacher read own groups"
  on public.group_module_topics for select
  to authenticated
  using (
    has_role(auth.uid(), 'teacher'::app_role)
    and public.is_group_teacher(group_module_topics.group_id, auth.uid())
  );

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 6) DM reconcilers — FAN OUT per teacher (correctness-critical).
--    A submission must enqueue/heal exactly one queue row for EVERY teacher of the group
--    (primary ∪ junction), teacher_id in the per-teacher dedupe → no double, no miss. Every OTHER
--    guard (quiet hours, per-source message_url incl. the miniapp bot-deep-link coalesce, 48h/10min
--    cycle window, cycle-aware reopen, SAP-aware task_number) is byte-for-byte the source.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- 6.1 reconcile_teacher_dm_queue  (src: 20260818170000_miniapp_dm_reconciler_and_health.sql:35)
--     Change vs source (ONLY the teacher derivation + per-teacher dedupe):
--       * the single-primary `join groups g on g.id = p.group_id and g.teacher_id is not null`
--         becomes a derived set of ALL (group_id, teacher_id) pairs = primary ∪ junction, still
--         aliased `g` exposing `.id`/`.teacher_id`, so every g.teacher_id / g.id reference below is
--         unchanged and the statement fans out one row per teacher.
--       * the submission-scoped "already notified this cycle" not-exists (q2) gains
--         `and q2.teacher_id = g.teacher_id` so a co-teacher with NO fresh row is still enqueued/
--         reopened when the primary already has one (identical behavior for the primary — the fresh
--         row IS the primary's — so this is backward-compatible while making fan-out actually reach
--         co-teachers before Stage B ships the webhook fan-out).
create or replace function public.reconcile_teacher_dm_queue()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _n1 int := 0; _n2 int := 0;
  _tash timestamptz := now() + interval '5 hours';
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
  _bot_username text;
begin
  if _hour >= 22 then _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else _sched := now(); end if;

  select value->>'bot_username' into _bot_username from platform_settings where key = 'telegram';
  _bot_username := coalesce(_bot_username, ''); -- degraded-but-still-valid https URL, mirrors submit-homework's own fallback

  -- Pass 1: RE-OPEN the existing row when the same (submission, teacher, url) row exists but
  -- predates the cycle (unique index forbids a duplicate insert). The drainer redelivers it.
  with cycles as (
    select hs.id, hs.user_id, hs.attempt_number, hs.submitted_at,
           case when hs.source = 'miniapp'
                then 'https://t.me/' || _bot_username || '?start=hw_' || hs.id::text || '_' || coalesce(hs.attempt_number, 1)::text
                else hs.telegram_message_url end as expected_url
    from homework_submissions hs
    where hs.source in ('telegram_topic', 'miniapp')
      and (hs.score is null or hs.score_is_stale)
      and hs.submitted_at > now() - interval '48 hours'
      and hs.submitted_at < now() - interval '10 minutes'
  )
  update homework_teacher_dm_queue q set
    sent_at = null, error = null, retry_count = 0,
    scheduled_for = _sched, queued_for_quiet_hours = (_hour >= 22 or _hour < 8),
    created_at = now(),
    assignment_title = case when q.assignment_title like '%(tiklandi)%' then q.assignment_title
                            else q.assignment_title || ' (tiklandi)' end
  from cycles hs
  join profiles p on p.id = hs.user_id
  join (
    select g.id, g.teacher_id from groups g where g.teacher_id is not null
    union
    select gt.group_id as id, gt.teacher_id from group_teachers gt
  ) g on g.id = p.group_id
  where q.submission_id = hs.id and q.teacher_id = g.teacher_id
    and q.message_url = hs.expected_url
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.teacher_id = g.teacher_id
                       and q2.created_at >= hs.submitted_at - interval '2 minutes');
  get diagnostics _n1 = row_count;

  -- Pass 2: INSERT for cycles whose URL is new (no matching row exists).
  with cycles as (
    select hs.id, hs.user_id, hs.attempt_number, hs.submitted_at, hs.assignment_id,
           case when hs.source = 'miniapp'
                then 'https://t.me/' || _bot_username || '?start=hw_' || hs.id::text || '_' || coalesce(hs.attempt_number, 1)::text
                else hs.telegram_message_url end as expected_url
    from homework_submissions hs
    where hs.source in ('telegram_topic', 'miniapp')
      and (hs.score is null or hs.score_is_stale)
      and hs.submitted_at > now() - interval '48 hours'
      and hs.submitted_at < now() - interval '10 minutes'
  )
  insert into homework_teacher_dm_queue
    (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
     module_number, task_number, assignment_title, student_name, message_url,
     scheduled_for, queued_for_quiet_hours)
  select hs.id, g.teacher_id, hs.user_id, g.id, a.module_id, a.id,
         m.position + 1, case when a.parent_id is not null then coalesce(a.sap_number, a.task_number, 1) else coalesce(a.task_number, 1) end,
         a.title || ' (tiklandi)',
         (coalesce(nullif(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), '—')
           || case when coalesce(p.telegram_username,'') <> '' then ' (@' || replace(p.telegram_username,'@','') || ')' else '' end),
         hs.expected_url,
         _sched, (_hour >= 22 or _hour < 8)
  from cycles hs
  join profiles p on p.id = hs.user_id
  join (
    select g.id, g.teacher_id from groups g where g.teacher_id is not null
    union
    select gt.group_id as id, gt.teacher_id from group_teachers gt
  ) g on g.id = p.group_id
  join homework_assignments a on a.id = hs.assignment_id
  join modules m on m.id = a.module_id
  where hs.expected_url is not null
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.teacher_id = g.teacher_id
                       and q2.created_at >= hs.submitted_at - interval '2 minutes')
    and not exists (select 1 from homework_teacher_dm_queue q3
                     where q3.submission_id = hs.id and q3.teacher_id = g.teacher_id and q3.message_url = hs.expected_url)
  on conflict do nothing;
  get diagnostics _n2 = row_count;

  if (_n1 + _n2) > 0 then raise log 'reconcile_teacher_dm_queue: reopened %, inserted %', _n1, _n2; end if;
  return _n1 + _n2;
end;
$function$;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;

-- 6.2 hw_dm_fallback_deliver  (src: 20260711130000_teacher_dm_100_reliability.sql:80)
--     The RBAC "still assigned" re-check on each unsent queue row derived ONE teacher via
--       join groups g on g.id = q.group_id and g.teacher_id = q.teacher_id
--     which drops every co-teacher's queue row (q.teacher_id never equals the single primary), so the
--     SQL fallback would never redeliver a co-teacher DM. Swap ONLY that teachership predicate for the
--     junction helper; the join to groups stays as the existence gate, everything else is verbatim.
create or replace function public.hw_dm_fallback_deliver()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _tok text;
  _row record;
  _sent int := 0;
  _tash_hour int := extract(hour from now() + interval '5 hours')::int;
  _admin record;
begin
  -- Respect quiet hours: the fallback never pings a teacher at night either.
  if _tash_hour >= 22 or _tash_hour < 8 then return 0; end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _row in
    select q.id, q.student_name, q.module_number, q.task_number, q.assignment_title,
           q.message_url, q.submission_id, t.telegram_id, t.preferred_locale
    from homework_teacher_dm_queue q
    join groups g on g.id = q.group_id and public.is_group_teacher(q.group_id, q.teacher_id)  -- RBAC: still assigned
    join profiles t on t.id = q.teacher_id
      and t.telegram_id is not null and t.notifications_enabled is distinct from false
    where q.sent_at is null
      and q.scheduled_for < now() - interval '15 minutes'  -- primary path has clearly failed
    order by q.scheduled_for
    limit 50
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'chat_id', _row.telegram_id,
          'parse_mode', 'HTML',
          'text', '📝 <b>Yangi topshiriq</b>' || E'\n\n<b>' || coalesce(_row.student_name, '—')
                  || '</b> Modul ' || _row.module_number || ' · Vazifa ' || _row.task_number
                  || ' ni topshirdi' || case when coalesce(_row.assignment_title,'') <> ''
                       then E'\n«' || _row.assignment_title || '»' else '' end,
          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),
            jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id)
          )))
        )
      );
      update homework_teacher_dm_queue
        set sent_at = now(), error = 'sql_fallback_delivery' where id = _row.id;
      _sent := _sent + 1;
    exception when others then
      update homework_teacher_dm_queue
        set error = 'sql_fallback_err: ' || left(sqlerrm, 200) where id = _row.id;
    end;
  end loop;

  -- If the fallback had to act, the primary path is sick — tell the admins (max 1 alert / 2h).
  if _sent > 0 and not exists (
    select 1 from notifications_log
    where notification_type = 'hw_dm_fallback' and sent_at > now() - interval '2 hours'
  ) then
    for _admin in
      select distinct p.id, p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('chat_id', _admin.telegram_id,
            'text', '🛟 Zaxira kanal ' || _sent || ' ta o''qituvchi DM yetkazdi — asosiy drainer (notify-homework-submission) ishlamayapti. Tekshiring.'));
        insert into notifications_log (user_id, notification_type, sent_at)
        values (_admin.id, 'hw_dm_fallback', now());
        exit; -- one log row is enough for the rate-limit
      exception when others then null;
      end;
    end loop;
  end if;

  return _sent;
end;
$$;
revoke execute on function public.hw_dm_fallback_deliver() from public, anon, authenticated;
