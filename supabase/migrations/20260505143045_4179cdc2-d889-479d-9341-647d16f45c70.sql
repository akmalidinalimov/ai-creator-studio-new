CREATE OR REPLACE FUNCTION public.recalc_leaderboard()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  max_lessons int;
  max_minutes int;
  weights jsonb;
  w_lessons numeric;
  w_homework numeric;
  w_streak numeric;
  w_minutes numeric;
  w_no_hw_total numeric;
BEGIN
  SELECT value INTO weights FROM app_settings WHERE key = 'engagement.activity_score_weights';
  w_lessons  := COALESCE(NULLIF((weights->>'lessons'),'')::numeric, 0.4);
  w_homework := COALESCE(NULLIF((weights->>'homework'),'')::numeric, 0.3);
  w_streak   := COALESCE(NULLIF((weights->>'streak'),'')::numeric, 0.2);
  w_minutes  := COALESCE(NULLIF((weights->>'minutes'),'')::numeric, 0.1);
  w_no_hw_total := w_lessons + w_streak + w_minutes;
  IF w_no_hw_total <= 0 THEN w_no_hw_total := 0.7; END IF;

  CREATE TEMP TABLE tmp_lb ON COMMIT DROP AS
  SELECT
    p.id AS user_id,
    COALESCE((SELECT COUNT(*)::int FROM lesson_progress lp
              WHERE lp.user_id = p.id
                AND lp.completed_at >= now() - interval '30 days'), 0) AS lessons_30d,
    COALESCE((SELECT (SUM(total_seconds)/60)::int FROM daily_watch_summary d
              WHERE d.user_id = p.id
                AND d.watch_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 30), 0) AS minutes_30d,
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak,
    COALESCE((SELECT AVG(score)::numeric FROM homework_submissions hs
              WHERE hs.user_id = p.id
                AND hs.score IS NOT NULL
                AND hs.scored_at >= now() - interval '30 days'), NULL) AS avg_hw
  FROM profiles p
  WHERE p.status = 'active'
    AND NOT has_role(p.id, 'admin'::app_role)
    AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(lessons_30d), 1), GREATEST(MAX(minutes_30d), 1)
    INTO max_lessons, max_minutes FROM tmp_lb;

  DELETE FROM leaderboard_cache;
  INSERT INTO leaderboard_cache (user_id, score, lessons_30d, minutes_30d, current_streak, rank, computed_at)
  SELECT
    user_id,
    LEAST(100, GREATEST(0, ROUND(
      CASE WHEN avg_hw IS NULL THEN
        ((w_lessons * (lessons_30d::numeric / max_lessons))
         + (w_streak  * (LEAST(current_streak, 30)::numeric / 30))
         + (w_minutes * (minutes_30d::numeric / max_minutes))) / w_no_hw_total * 100
      ELSE
        ((w_lessons  * (lessons_30d::numeric / max_lessons))
         + (w_homework * (avg_hw / 10))
         + (w_streak   * (LEAST(current_streak, 30)::numeric / 30))
         + (w_minutes  * (minutes_30d::numeric / max_minutes))) * 100
      END
    )::int)) AS score,
    lessons_30d, minutes_30d, current_streak, NULL::int, now()
  FROM tmp_lb;

  WITH ranked AS (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY score DESC, lessons_30d DESC, current_streak DESC) AS r
    FROM leaderboard_cache
  )
  UPDATE leaderboard_cache lc SET rank = ranked.r FROM ranked WHERE ranked.user_id = lc.user_id;
END;
$function$;