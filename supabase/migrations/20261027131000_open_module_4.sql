-- Challenge 6.0: open module 4 «CLAUDE AI VA CODEX BILAN AVTOMATLASHTIRISH» (owner, 2026-10-27: "open the 4th modul
-- for everyone"). All 227 enrolled students share the one tier «AC CHALLENGE» (module_limit 3 → 4). Checked first: the
-- module's 8 lessons are published and every one has a video; its homework assignment exists. Everything reads the limit
-- live (has_module_access, lesson-video-url, the Mini App, the homework guess, the reminders), so nothing else changes.
-- Module 5 «AI BILAN DAROMAD TOPISH» stays locked; the BONUS module stays open (modules.always_open).
-- Guarded on the current value: a replay, or a limit already raised by hand in the admin editor, is left alone.
do $$
declare _n int;
begin
  update public.course_tiers set module_limit = 4
   where id = '0acd8b0a-bf8c-4a59-be0c-90219f18ab99'
     and course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
     and module_limit = 3;
  get diagnostics _n = row_count;
  if _n = 1 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'course_tier_module_limit_changed', jsonb_build_object(
      'tier_id', '0acd8b0a-bf8c-4a59-be0c-90219f18ab99', 'tier', 'AC CHALLENGE', 'from', 3, 'to', 4,
      'module', 'CLAUDE AI VA CODEX BILAN AVTOMATLASHTIRISH', 'migration', '20261027131000'));
  else
    raise notice 'module 4: tier already changed (module_limit is not 3) — left as it is';
  end if;
end $$;
