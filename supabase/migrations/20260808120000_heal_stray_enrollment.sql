-- Heal a stray finished-course enrollment (2026-08-08). The enrollment-watchdog flagged 1 student
-- (Ёркиной) correctly in a 5.0 group but also carrying a leftover AI CREATORS 4.0 (finished) enrollment
-- — created 2026-08-05 during a cross-course re-add/move (the group-assignment trigger adds the new
-- course but doesn't drop the old one). Same guarded, audited DELETE as 20260725120000: only removes a
-- stray whose course is UNPUBLISHED (finished) AND whose owner is in an ACTIVE (tiered) group AND who
-- ALREADY has that active-course enrollment — so no student is ever left with zero enrollments. Full
-- row detail is captured to admin_actions for restore. Idempotent (a re-run matches nothing). The
-- enrollment-watchdog then self-recovers on its next run (stray=0 → "✅ normalized").
do $$
declare _n int; _rows jsonb;
begin
  with del as (
    delete from public.enrollments e
    using public.profiles p, public.groups g
    where e.user_id = p.id
      and g.id = p.group_id
      and e.course_id <> g.course_id
      and exists (select 1 from public.course_tiers ct where ct.course_id = g.course_id)                  -- group course is active/tiered
      and exists (select 1 from public.courses fc where fc.id = e.course_id and fc.published = false)      -- stray course is finished
      and exists (select 1 from public.enrollments e2 where e2.user_id = p.id and e2.course_id = g.course_id)  -- keeps the real one
    returning e.user_id, e.course_id, e.tier_id, e.enrolled_at
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'user_id', user_id, 'course_id', course_id, 'tier_id', tier_id, 'enrolled_at', enrolled_at)), '[]'::jsonb)
    into _n, _rows from del;
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'stray_enrollment_heal', jsonb_build_object('removed', _n, 'rows', _rows, 'at', now(), 'source', '20260808120000'));
  exception when others then null;  -- audit best-effort
  end;
end $$;
