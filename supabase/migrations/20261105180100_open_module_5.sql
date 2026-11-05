-- Challenge 6.0: open module 5 «AI BILAN DAROMAD TOPISH» (owner, 2026-11-05: "open 5th modul lessons"). All 227 enrolled
-- students share the one tier «AC CHALLENGE» (module_limit 4 → 5). Checked first: the module's 4 lessons are published;
-- 5.1–5.3 have a video, 5.4 is a text lesson by design (its title says so). The module has NO homework assignment, so
-- nothing new is due. Everything reads the limit live (has_module_access, lesson-video-url, the Mini App, the homework
-- guess, the reminders), so nothing else changes. The BONUS module stays open (modules.always_open).
-- Guarded on the current value: a replay, or a limit already raised by hand in the admin editor, is left alone.
do $$
declare _n int;
begin
  update public.course_tiers set module_limit = 5
   where id = '0acd8b0a-bf8c-4a59-be0c-90219f18ab99'
     and course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
     and module_limit = 4;
  get diagnostics _n = row_count;
  if _n = 1 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'course_tier_module_limit_changed', jsonb_build_object(
      'tier_id', '0acd8b0a-bf8c-4a59-be0c-90219f18ab99', 'tier', 'AC CHALLENGE', 'from', 4, 'to', 5,
      'module', 'AI BILAN DAROMAD TOPISH', 'migration', '20261105180100'));
  else
    raise notice 'module 5: tier already changed (module_limit is not 4) — left as it is';
  end if;
end $$;
