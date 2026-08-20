-- New read-only RPC for the teacher Mini App's "Lessons" tab: teacher_courses().
--
-- Returns the distinct PUBLISHED courses the calling teacher (or co-teacher) is assigned
-- to, via the junction-aware public.teacher_group_ids(uuid) primitive (primary
-- groups.teacher_id UNION group_teachers — see PR #86/#88 "multi-teacher per group").
--
-- Anon-safe by construction, no separate role gate needed: anon's auth.uid() is NULL, so
-- the `auth.uid() IS NOT NULL` guard alone returns zero rows for an unauthenticated caller
-- (never the `auth.uid() is null` anti-pattern flagged in security-definer-anon-guard — this
-- is the correct direction, requiring uid to be non-null rather than allowing on null). A
-- signed-in student who teaches no group gets zero rows because teacher_group_ids(auth.uid())
-- returns nothing for them. Only a caller who is teacher_id or a co-teacher of at least one
-- group gets that group's course(s). An admin who is not a group's teacher/co-teacher
-- intentionally gets nothing here too — this RPC answers "courses I teach", not an
-- admin-wide view; admins already have other surfaces for that.
--
-- Locked down with the grant pattern shipped in 20260820090000/20260820100000: REVOKE from
-- PUBLIC/anon, GRANT to authenticated + service_role only.
--
-- Pure new function, no schema or data change.
CREATE OR REPLACE FUNCTION public.teacher_courses()
RETURNS TABLE(course_id uuid, title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT DISTINCT c.id, c.title
  FROM public.courses c
  WHERE c.published = true
    AND auth.uid() IS NOT NULL
    AND c.id IN (
      SELECT g.course_id FROM public.groups g
      WHERE g.course_id IS NOT NULL
        AND g.id IN (SELECT public.teacher_group_ids(auth.uid()))
    )
  ORDER BY c.title;
$function$;

REVOKE ALL ON FUNCTION public.teacher_courses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_courses() TO authenticated, service_role;
