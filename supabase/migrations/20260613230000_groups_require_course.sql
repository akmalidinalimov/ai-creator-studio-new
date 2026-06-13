-- P1 of course-dependent groups: every group must belong to a course.
-- Backfill legacy NULL-course groups to the default-for-signup course (AI CREATORS 4.0),
-- then require course_id on FUTURE writes. NOT VALID = no table scan / no lock on the hot
-- table and cannot fail on legacy rows; the backfill above guarantees there are none left.
--
-- GOLDEN BASELINE: this only sets a previously-NULL column on the groups rows; no student,
-- progress, submission, streak, or leaderboard row is touched. With one active cohort today,
-- all groups resolve to 4.0 and every "filter by course" stays a no-op.

UPDATE public.groups
SET course_id = (
  SELECT id FROM public.courses WHERE is_default_for_signup = true ORDER BY created_at LIMIT 1
)
WHERE course_id IS NULL;

ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_course_required;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_course_required CHECK (course_id IS NOT NULL) NOT VALID;
