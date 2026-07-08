-- Teacher engagement measurement (2026-07-08) — Teacher Engagement, Phase 6.
-- One-glance health RPC so we can tell whether the system works — and, crucially, whether it's
-- quietly making quality worse (the research's warning: reward speed and you get rubber-stamped
-- grades). Admin-only. Pair with a pre-launch baseline: call it now, compare over time.
--
--   Driver mix  : XP awarded by source (grade / on-time / answer / impact / queue-clear / active-day)
--   Leading      : on-time grading rate
--   GUARDRAILS   : feedback_pct (did they actually write feedback), top_pct (rubber-stamp signal),
--                  nudges_sent (fatigue risk), optout_teachers (goodwill)

create or replace function public.admin_teacher_engagement_health(p_days int default 14)
returns table(
  active_teachers int,
  xp_grade int, xp_ontime int, xp_answer int, xp_impact int, xp_queueclear int, xp_activeday int,
  ontime_pct numeric, feedback_pct numeric, top_pct numeric,
  nudges_sent int, optout_teachers int
)
language sql stable security definer set search_path = public
as $$
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
  where has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role) or auth.uid() is null;
$$;
grant execute on function public.admin_teacher_engagement_health(int) to authenticated;
