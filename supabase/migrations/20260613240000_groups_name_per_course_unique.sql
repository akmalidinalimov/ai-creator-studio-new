-- P2 of course-dependent groups: group names are unique per COURSE, not globally.
-- Lets "AI CREATORS 4.0 / Group A" and "AI CREATORS 5.0 / Group A" coexist.
-- Pre-flight (should be 0 rows after the P1 backfill):
--   SELECT lower(name), course_id, count(*) FROM groups GROUP BY 1,2 HAVING count(*) > 1;
--
-- GOLDEN BASELINE: existing names are already unique within 4.0, so the composite index
-- changes no existing row; it only stops cross-course name collisions going forward.

DROP INDEX IF EXISTS public.groups_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_course_unique
  ON public.groups (lower(name), course_id);
