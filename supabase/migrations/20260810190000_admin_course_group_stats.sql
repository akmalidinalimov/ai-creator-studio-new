-- admin_course_group_stats(): per-group student statistics for a course, for the admin Statistics
-- dashboard. One row per group in the course (grouped, live members only: status='active' AND
-- archived_at IS NULL). Admin/service scoped (all groups of the course). All course-sensitive metrics
-- are COURSE-SCOPED so dual-enrolled/legacy students don't bleed cross-course XP/homework in:
--   * completion — tier-clamped by module RANK (row_number over position, created_at) <= module_limit,
--     matching is_module_tier_locked / profile_stats (robust to non-contiguous module positions).
--   * XP — public.user_course_xp(student, course) (not lifetime user_xp.total_xp).
--   * homework — joined through homework_assignments -> modules.course_id = _course_id.
-- "Active" = a lesson_progress touch in the window (default 7d). Server-side aggregation on purpose
-- (client-side hits PostgREST's 1000-row cap — a known bug class). The dashboard sums these grouped
-- rows for course "overall" totals. Validated read-only on prod 2026-08-10.

create or replace function public.admin_course_group_stats(_course_id uuid, _window_days int default 7)
returns table(
  group_id uuid, group_name text, tier_name text, teacher_name text,
  total_students int, active_students int, activated_count int,
  badges_earned int, students_with_badges int,
  avg_completion_pct int, accessible_lessons int,
  total_xp bigint, avg_xp int,
  homework_submitted int, homework_avg_score numeric, pending_homework int
)
language sql
stable
security definer
set search_path = public
as $$
  with ok as (
    select (auth.uid() is null
            or has_role(auth.uid(), 'admin'::app_role)
            or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  gs as (
    select g.id as gid, g.name as gname, g.tier_id, ct.name as tier_name, ct.module_limit,
           coalesce(nullif(trim(concat(tp.name, ' ', coalesce(tp.last_name, ''))), ''), tp.email) as teacher_name
    from groups g
    left join course_tiers ct on ct.id = g.tier_id
    left join profiles tp on tp.id = g.teacher_id
    where g.course_id = _course_id and (select allowed from ok)
  ),
  members as (
    select p.id as student_id, p.group_id as gid
    from profiles p
    join gs on gs.gid = p.group_id
    where p.status = 'active' and p.archived_at is null
  ),
  -- Accessible modules per group, tier-clamped by RANK (position/created_at), not raw position —
  -- matches the canonical is_module_tier_locked / profile_stats definition.
  grp_modules as (
    select gs.gid, m.id as module_id, gs.module_limit,
      row_number() over (partition by gs.gid order by m.position, m.created_at) as rn
    from gs
    join modules m on m.course_id = _course_id
  ),
  grp_lessons as (
    select gm.gid, l.id as lesson_id
    from grp_modules gm
    join lessons l on l.module_id = gm.module_id
    where gm.module_limit is null or gm.rn <= gm.module_limit
  ),
  grp_lesson_count as (
    select gid, count(*)::int as n from grp_lessons group by gid
  ),
  done as (
    select mem.gid, mem.student_id, count(lp.lesson_id) as n_done
    from members mem
    join grp_lessons gl on gl.gid = mem.gid
    left join lesson_progress lp
      on lp.user_id = mem.student_id and lp.lesson_id = gl.lesson_id and lp.completed_at is not null
    group by mem.gid, mem.student_id
  ),
  completion as (
    select d.gid, round(avg(d.n_done * 100.0 / nullif(glc.n, 0)))::int as avg_completion_pct
    from done d join grp_lesson_count glc on glc.gid = d.gid
    group by d.gid
  ),
  act as (
    select mem.gid, count(distinct mem.student_id) as n
    from members mem
    join lesson_progress lp on lp.user_id = mem.student_id
      and lp.updated_at >= now() - make_interval(days => _window_days)
    group by mem.gid
  ),
  activated as (
    select mem.gid, count(distinct mem.student_id) as n
    from members mem
    join auth.users au on au.id = mem.student_id and au.last_sign_in_at is not null
    group by mem.gid
  ),
  bdg as (
    select mem.gid, count(ub.id)::int as n, count(distinct ub.user_id)::int as students_with
    from members mem
    join user_badges ub on ub.user_id = mem.student_id
    group by mem.gid
  ),
  -- Course-scoped XP (not lifetime user_xp.total_xp), averaged over ALL members.
  xp as (
    select mem.gid,
      coalesce(sum(public.user_course_xp(mem.student_id, _course_id)), 0)::bigint as total,
      coalesce(round(avg(public.user_course_xp(mem.student_id, _course_id))), 0)::int as avg
    from members mem
    group by mem.gid
  ),
  -- Homework scoped to THIS course's assignments.
  hw as (
    select mem.gid,
      count(*)::int as submitted,
      round(avg(hs.score) filter (where hs.score is not null), 1) as avg_score,
      count(*) filter (where hs.score is null and hs.submitted_at is not null)::int as pending
    from homework_submissions hs
    join members mem on mem.student_id = hs.user_id
    join homework_assignments ha on ha.id = hs.assignment_id
    join modules m2 on m2.id = ha.module_id and m2.course_id = _course_id
    group by mem.gid
  )
  select gs.gid, gs.gname, gs.tier_name,
         coalesce(gs.teacher_name, '—'),
         (select count(*)::int from members where gid = gs.gid),
         coalesce((select n from act where gid = gs.gid), 0)::int,
         coalesce((select n from activated where gid = gs.gid), 0)::int,
         coalesce((select n from bdg where gid = gs.gid), 0)::int,
         coalesce((select students_with from bdg where gid = gs.gid), 0)::int,
         coalesce((select avg_completion_pct from completion where gid = gs.gid), 0)::int,
         coalesce((select n from grp_lesson_count where gid = gs.gid), 0)::int,
         coalesce((select total from xp where gid = gs.gid), 0)::bigint,
         coalesce((select avg from xp where gid = gs.gid), 0)::int,
         coalesce((select submitted from hw where gid = gs.gid), 0)::int,
         (select avg_score from hw where gid = gs.gid)::numeric,
         coalesce((select pending from hw where gid = gs.gid), 0)::int
  from gs
  order by gs.gname;
$$;

revoke execute on function public.admin_course_group_stats(uuid, int) from public, anon;
grant execute on function public.admin_course_group_stats(uuid, int) to authenticated, service_role;
