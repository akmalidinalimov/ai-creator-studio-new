-- Candidates: inactive for N..N+1 days (based on most recent lesson_progress.updated_at), logged in at least once
CREATE OR REPLACE FUNCTION public.nudge_candidates_inactive(_days int)
RETURNS TABLE(
  id uuid,
  name text,
  preferred_locale text,
  preferred_language text,
  telegram_id bigint,
  tashkent_offset_minutes int,
  teacher_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH last_act AS (
    SELECT user_id, MAX(updated_at) AS last_at FROM public.lesson_progress GROUP BY user_id
  )
  SELECT
    p.id,
    p.name,
    p.preferred_locale,
    p.preferred_language,
    p.telegram_id,
    p.tashkent_offset_minutes,
    tp.name AS teacher_name
  FROM public.profiles p
  JOIN last_act la ON la.user_id = p.id
  LEFT JOIN public.groups g ON g.id = p.group_id
  LEFT JOIN public.profiles tp ON tp.id = g.teacher_id
  WHERE p.telegram_id IS NOT NULL
    AND p.status = 'active'
    AND la.last_at < now() - make_interval(days => _days)
    AND la.last_at > now() - make_interval(days => _days + 1);
$$;

REVOKE ALL ON FUNCTION public.nudge_candidates_inactive(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_candidates_inactive(int) TO service_role;

-- Candidates: stuck on a lesson (rewatched 2+ times in last 3 days, not completed)
-- We approximate "watched 2+ times" as 2+ distinct days of lesson_progress updates for the same lesson.
CREATE OR REPLACE FUNCTION public.nudge_candidates_stuck()
RETURNS TABLE(
  id uuid,
  name text,
  preferred_locale text,
  preferred_language text,
  telegram_id bigint,
  tashkent_offset_minutes int,
  lesson_id uuid,
  lesson_title text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH watches AS (
    SELECT lp.user_id, lp.lesson_id, COUNT(DISTINCT date_trunc('day', lp.updated_at)) AS days
    FROM public.lesson_progress lp
    WHERE lp.updated_at > now() - interval '3 days'
      AND lp.completed_at IS NULL
    GROUP BY lp.user_id, lp.lesson_id
    HAVING COUNT(DISTINCT date_trunc('day', lp.updated_at)) >= 2
  )
  SELECT DISTINCT ON (p.id)
    p.id,
    p.name,
    p.preferred_locale,
    p.preferred_language,
    p.telegram_id,
    p.tashkent_offset_minutes,
    w.lesson_id,
    l.title AS lesson_title
  FROM watches w
  JOIN public.profiles p ON p.id = w.user_id
  JOIN public.lessons l ON l.id = w.lesson_id
  WHERE p.telegram_id IS NOT NULL AND p.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.nudge_candidates_stuck() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_candidates_stuck() TO service_role;