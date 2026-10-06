-- Challenge 6.0: open module 2 for everyone (owner request, 2026-10-06).
--
-- All 199 course-6.0 enrolments are on the one tier «AC CHALLENGE» (module_limit 1, verified: 0 tierless). Raising it
-- to 2 opens module 2 «AI BILAN PROFESSIONAL RASM QILISH» (11 published lessons, all with video) through the normal
-- gate (has_module_access / is_module_tier_locked / my_module_limit), together with its homework
-- (student_assignable_homework). tier_config_watchdog only judges VIP / PREM groups, so 6.0 cannot trip it.
-- Replay-safe: only 1 → 2 (a later raise by the owner is never lowered back).

do $$
declare
  _tier constant uuid := '0acd8b0a-bf8c-4a59-be0c-90219f18ab99';
  _n int;
begin
  if not exists (select 1 from public.course_tiers t
                  where t.id = _tier and t.course_id = 'f502f631-2104-4834-b6c2-702cd3080e27' and t.name = 'AC CHALLENGE') then
    raise exception 'ABORT: tier % is not the course-6.0 «AC CHALLENGE» tier', _tier;
  end if;

  update public.course_tiers set module_limit = 2 where id = _tier and module_limit = 1;
  get diagnostics _n = row_count;

  if _n > 0 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'course_tier_module_limit_changed', jsonb_build_object(
      'migration', '20261006053000', 'tier_id', _tier, 'tier', 'AC CHALLENGE', 'from', 1, 'to', 2,
      'reason', 'owner: open module 2 for all Challenge 6.0 students', 'at', now()));
  end if;
end $$;
