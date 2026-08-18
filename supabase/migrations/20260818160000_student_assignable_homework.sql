-- In-app homework upload (item 4) — picker data source.
--
-- student_assignable_homework(): returns the CALLING student's submittable LEAF homework
-- assignments (a task with no SAP children, or each SAP child), scoped to their current
-- course(s) and clamped to their tier, with their current submission state for each leaf.
-- This centralizes the tier + leaf logic that the bot (telegram-bot-webhook/index.ts) computes
-- in TypeScript (getCourseIdsForUser ~1943, getBlockedModuleIds ~2057, buildHomeworkMessage
-- ~2410-2483) so the Mini App has one read-only, SECURITY DEFINER call to build its picker.
--
-- Tier gating reuses public.has_module_access(uid, module_id) (course_tiers.sql, 2026-06-13) —
-- the canonical, already-tested tier check — rather than re-deriving blocked module ids, so any
-- future tier-logic change only needs to happen in one place.
--
-- state per leaf mirrors the SAME unification the bot's teacher grading screen already uses
-- (telegram-bot-webhook/index.ts:4042-4045) across the two co-existing resubmission mechanisms:
--   - bot capture path: resets score to NULL, stamps previous_score (scalar) as grade memory.
--   - start_homework_resubmission() RPC path (web self-service "Qayta topshirish" button,
--     src/components/lesson/HomeworkSection.tsx): keeps score, flags score_is_stale = true,
--     archives the prior attempt into previous_attempts (jsonb).
-- Both are treated as "needs_redo" here so a future Mini App UI never has to know which
-- mechanism produced the state.
create or replace function public.student_assignable_homework()
returns table (
  assignment_id uuid,
  module_id uuid,
  module_number int,
  module_title text,
  is_sap boolean,
  step_number int,
  title text,
  max_score smallint,
  state text,
  score smallint,
  attempt_number int,
  submission_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  return query
  with caller as (
    select v_caller as uid
  ),
  prof as (
    select p.group_id from public.profiles p where p.id = v_caller
  ),
  group_course_published as (
    -- Mirrors getCourseIdsForUser step 1: profile.group_id -> groups.course_id, ONLY if that
    -- course is published. A student in a deactivated course's group falls through to step 2.
    select g.course_id
    from prof, public.groups g
    join public.courses c on c.id = g.course_id
    where g.id = prof.group_id and c.published = true
  ),
  enrolled_courses as (
    -- Step 2: every published course the student is directly enrolled in.
    select e.course_id
    from public.enrollments e
    join public.courses c on c.id = e.course_id
    where e.user_id = v_caller and c.published = true
      and not exists (select 1 from group_course_published)
  ),
  default_course as (
    -- Step 3: platform default (is_default_for_signup first, else oldest published course).
    select c.id as course_id
    from public.courses c
    where c.published = true
      and not exists (select 1 from group_course_published)
      and not exists (select 1 from enrolled_courses)
    order by c.is_default_for_signup desc, c.created_at asc
    limit 1
  ),
  course_scope as (
    select course_id from group_course_published
    union all
    select course_id from enrolled_courses
    union all
    select course_id from default_course
  ),
  scoped_assignments as (
    select
      a.id, a.module_id, a.title, a.max_score, a.task_number, a.sap_number, a.parent_id,
      m.position as module_position, m.title as module_title
    from public.homework_assignments a
    join public.modules m on m.id = a.module_id
    where a.is_active = true
      and m.course_id in (select course_id from course_scope)
  ),
  parent_ids_with_children as (
    select distinct sa.parent_id
    from scoped_assignments sa
    where sa.parent_id is not null
  ),
  leaves as (
    -- A leaf = a SAP sub-step, or a task with no SAP children (mirrors computeLeaves() in
    -- telegram-bot-webhook/homework-routing.ts and buildHomeworkMessage's inline filter).
    select sa.*
    from scoped_assignments sa
    where sa.parent_id is not null
       or not exists (
         select 1 from parent_ids_with_children p where p.parent_id = sa.id
       )
  ),
  tier_ok as (
    -- Tier clamp (Phase 2): drop leaves in modules beyond the student's tier. NULL-tier (every
    -- enrollment with module_limit IS NULL) students are unaffected — has_module_access returns
    -- true unconditionally for them.
    select l.*
    from leaves l
    where public.has_module_access(v_caller, l.module_id)
  )
  select
    t.id as assignment_id,
    t.module_id,
    (coalesce(t.module_position, 0) + 1)::int as module_number,
    t.module_title,
    (t.parent_id is not null) as is_sap,
    -- displayStepNumber(): SAP sub-step -> its own sap_number; plain task -> task_number.
    (case when t.parent_id is not null
       then coalesce(t.sap_number, t.task_number, 1)
       else coalesce(t.task_number, 1)
     end)::int as step_number,
    t.title,
    t.max_score,
    (case
       when s.id is null then 'none'
       when s.score is not null and not coalesce(s.score_is_stale, false) then 'graded'
       when s.score is not null and coalesce(s.score_is_stale, false) then 'needs_redo'
       when s.score is null and s.previous_score is not null then 'needs_redo'
       else 'pending'
     end) as state,
    s.score,
    s.attempt_number,
    s.id as submission_id
  from tier_ok t
  left join public.homework_submissions s
    on s.assignment_id = t.id and s.user_id = v_caller
  order by t.module_position, t.task_number, coalesce(t.sap_number, 0);
end;
$$;

grant execute on function public.student_assignable_homework() to authenticated;
