-- Per-course leaderboard (Phase 3 of course-awareness).
-- The standalone web leaderboard page used leaderboard_top / leaderboard_my_rank, which rank
-- across ALL students globally. With a second course (AI CREATORS 5.0) that mixes cohorts.
-- These additive *_for_user functions re-rank within the CALLER's course only.
--
-- "My course" mirrors the bot's getCourseIdsForUser: the caller's group's course, else their
-- first enrollment. A student is a "course member" if their group's course = my course, or
-- (no group) they're enrolled in my course. Re-rank that set by the same score ordering.
--
-- GOLDEN BASELINE: while only one course is published, every active student resolves to that
-- one course, so the member set = all students and the per-course rank == the global rank.
-- Byte-identical to leaderboard_top / leaderboard_my_rank today; only diverges once a second
-- course has its own cohort. The original global functions are left untouched.

CREATE OR REPLACE FUNCTION public.leaderboard_top_for_user(uid uuid, _limit int DEFAULT 10)
RETURNS TABLE(rank int, user_id uuid, first_name text, last_initial text, score int, current_streak int, lessons_30d int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH my_course AS (
    SELECT COALESCE(
      (SELECT g.course_id FROM profiles p JOIN groups g ON g.id = p.group_id WHERE p.id = uid),
      (SELECT e.course_id FROM enrollments e WHERE e.user_id = uid ORDER BY e.enrolled_at LIMIT 1)
    ) AS course_id
  ),
  course_members AS (
    SELECT DISTINCT p.id
    FROM profiles p
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.status = 'active' AND p.archived_at IS NULL
      AND (
        g.course_id = (SELECT course_id FROM my_course)
        OR (g.course_id IS NULL AND EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.user_id = p.id AND e.course_id = (SELECT course_id FROM my_course)))
      )
  ),
  ranked AS (
    SELECT lc.user_id, lc.score, lc.current_streak, lc.lessons_30d,
           ROW_NUMBER() OVER (ORDER BY lc.score DESC, lc.lessons_30d DESC, lc.current_streak DESC) AS r
    FROM leaderboard_cache lc
    JOIN course_members cm ON cm.id = lc.user_id
  )
  SELECT ranked.r::int AS rank, ranked.user_id,
         COALESCE(NULLIF(p.name,''), 'Talaba') AS first_name,
         COALESCE(LEFT(NULLIF(p.last_name,''),1), '') AS last_initial,
         ranked.score, ranked.current_streak, ranked.lessons_30d
  FROM ranked
  JOIN profiles p ON p.id = ranked.user_id
  WHERE (SELECT course_id FROM my_course) IS NOT NULL
  ORDER BY ranked.r
  LIMIT _limit;
$$;

CREATE OR REPLACE FUNCTION public.leaderboard_my_rank_for_user(uid uuid)
RETURNS TABLE(rank int, total int, score int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH my_course AS (
    SELECT COALESCE(
      (SELECT g.course_id FROM profiles p JOIN groups g ON g.id = p.group_id WHERE p.id = uid),
      (SELECT e.course_id FROM enrollments e WHERE e.user_id = uid ORDER BY e.enrolled_at LIMIT 1)
    ) AS course_id
  ),
  course_members AS (
    SELECT DISTINCT p.id
    FROM profiles p
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.status = 'active' AND p.archived_at IS NULL
      AND (
        g.course_id = (SELECT course_id FROM my_course)
        OR (g.course_id IS NULL AND EXISTS (
              SELECT 1 FROM enrollments e
              WHERE e.user_id = p.id AND e.course_id = (SELECT course_id FROM my_course)))
      )
  ),
  ranked AS (
    SELECT lc.user_id, lc.score,
           ROW_NUMBER() OVER (ORDER BY lc.score DESC, lc.lessons_30d DESC, lc.current_streak DESC) AS r
    FROM leaderboard_cache lc
    JOIN course_members cm ON cm.id = lc.user_id
  )
  SELECT
    (SELECT r::int FROM ranked WHERE user_id = uid),
    (SELECT COUNT(*)::int FROM ranked),
    (SELECT score FROM ranked WHERE user_id = uid);
$$;

GRANT EXECUTE ON FUNCTION public.leaderboard_top_for_user(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_my_rank_for_user(uuid) TO authenticated;
