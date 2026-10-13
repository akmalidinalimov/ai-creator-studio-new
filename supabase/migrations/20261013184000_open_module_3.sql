-- Challenge 6.0: open module 3 «AI BILAN PRO VIDEOLAR TAYYORLASH» (owner, 2026-10-13: "open the 3rd module lessons").
-- All 221 students share the one tier «AC CHALLENGE» (module_limit 2 → 3). Checked first: the module's 11 lessons are
-- published, every one has a video, and its 4 homework assignments exist. Everything reads the limit live
-- (has_module_access, lesson-video-url, the Mini App, the homework guess, the reminders), so nothing else changes.
-- Guarded on the current value: a replay, or a limit already raised by hand in the admin editor, is left alone.
do $$
declare _n int;
begin
  update public.course_tiers set module_limit = 3
   where id = '0acd8b0a-bf8c-4a59-be0c-90219f18ab99'
     and course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
     and module_limit = 2;
  get diagnostics _n = row_count;
  if _n = 1 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'course_tier_module_limit_changed', jsonb_build_object(
      'tier_id', '0acd8b0a-bf8c-4a59-be0c-90219f18ab99', 'tier', 'AC CHALLENGE', 'from', 2, 'to', 3,
      'module', 'AI BILAN PRO VIDEOLAR TAYYORLASH', 'migration', '20261013184000'));
  else
    raise notice 'module 3: tier already changed (module_limit is not 2) — left as it is';
  end if;
end $$;
