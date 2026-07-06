-- HOTFIX: restore authenticated read on modules (and thus lessons).
--
-- 20260705190000 dropped the wide-open "modules read" (=true) policy as part
-- of course-deactivation hardening, leaving modules with only an anon-scoped
-- read policy. Authenticated students therefore saw 0 modules — and 0 lessons,
-- because the "lessons read" policy's EXISTS(modules ...) subquery is itself
-- subject to modules RLS. Symptoms: empty course pages, "lesson not found"
-- on every video, watch-progress collapse (Jul 6: 1 row vs ~600/day).
--
-- Same publish gate as the anon policy: modules of PUBLISHED courses only,
-- for any authenticated user. Per-tier gating stays where it belongs — in
-- has_module_access / lesson-video-url — this only restores catalog visibility.

drop policy if exists "modules read published parent" on public.modules;
create policy "modules read published parent" on public.modules
  for select to authenticated
  using (exists (select 1 from public.courses c where c.id = modules.course_id and c.published));
