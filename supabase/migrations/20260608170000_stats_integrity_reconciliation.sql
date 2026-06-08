-- RECONCILIATION MIGRATION — captures DB changes applied directly via the Lovable
-- SQL editor during the 2026-06-08 stats-integrity work, so the repo matches the
-- live database. ALREADY APPLIED IN PRODUCTION — these are all idempotent
-- (CREATE OR REPLACE / IF NOT EXISTS / DROP+CREATE), safe to re-run on a fresh DB.
-- See docs/STATS-DEPENDENCIES.md.

-- 1) Canonical effective homework average (numeric, previous_attempts-aware).
CREATE OR REPLACE FUNCTION public.user_homework_avg10_effective(
  p_user_id uuid, p_within_days int DEFAULT NULL
)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH active AS (
    SELECT id, parent_id, max_score FROM homework_assignments WHERE COALESCE(is_active, true) = true
  ),
  parents_with_sap AS (SELECT DISTINCT parent_id FROM active WHERE parent_id IS NOT NULL),
  leaves AS (
    SELECT a.id, a.max_score FROM active a
    WHERE a.parent_id IS NOT NULL OR a.id NOT IN (SELECT parent_id FROM parents_with_sap)
  ),
  eff AS (
    SELECT l.max_score,
      COALESCE(hs.score,
        (SELECT (e->>'score')::numeric
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL AND (e->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
         ORDER BY ord DESC LIMIT 1)) AS effective_score,
      COALESCE(hs.scored_at,
        (SELECT (e->>'scored_at')::timestamptz
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL ORDER BY ord DESC LIMIT 1)) AS effective_scored_at
    FROM leaves l JOIN homework_submissions hs ON hs.assignment_id = l.id AND hs.user_id = p_user_id
  )
  SELECT CASE WHEN COALESCE(SUM(max_score),0) = 0 THEN NULL
              ELSE ROUND((SUM(effective_score) / SUM(max_score)) * 10, 1) END
  FROM eff
  WHERE effective_score IS NOT NULL
    AND (p_within_days IS NULL OR effective_scored_at >= now() - make_interval(days => p_within_days));
$fn$;

-- 2) Effective module homework view (used by AdminHomework).
CREATE OR REPLACE VIEW public.vw_module_homework_score_effective AS
WITH active AS (
  SELECT id, parent_id, max_score, module_id FROM homework_assignments WHERE COALESCE(is_active, true) = true
),
parents_with_sap AS (SELECT DISTINCT parent_id FROM active WHERE parent_id IS NOT NULL),
leaves AS (
  SELECT a.id, a.max_score, a.module_id FROM active a
  WHERE a.parent_id IS NOT NULL OR a.id NOT IN (SELECT parent_id FROM parents_with_sap)
),
eff AS (
  SELECT hs.user_id AS profile_id, l.module_id, l.max_score,
    COALESCE(hs.score,
      (SELECT (e->>'score')::numeric
       FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
       WHERE NULLIF(e->>'score','') IS NOT NULL AND (e->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
       ORDER BY ord DESC LIMIT 1)) AS effective_score
  FROM leaves l JOIN homework_submissions hs ON hs.assignment_id = l.id
)
SELECT profile_id, module_id,
  COUNT(*) FILTER (WHERE effective_score IS NOT NULL) AS scored_tasks,
  COUNT(*) AS submitted_tasks,
  SUM(effective_score) FILTER (WHERE effective_score IS NOT NULL) AS earned,
  SUM(max_score) FILTER (WHERE effective_score IS NOT NULL) AS max_scored,
  CASE WHEN COALESCE(SUM(max_score) FILTER (WHERE effective_score IS NOT NULL), 0) = 0 THEN NULL
       ELSE ROUND((SUM(effective_score) FILTER (WHERE effective_score IS NOT NULL)
                   / SUM(max_score) FILTER (WHERE effective_score IS NOT NULL)) * 10, 1) END AS avg10_normalized
FROM eff GROUP BY profile_id, module_id;

-- 3) Corrected recalc_leaderboard: normalized effective homework (was raw AVG), exclude archived.
CREATE OR REPLACE FUNCTION public.recalc_leaderboard()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  max_lessons int; max_minutes int; weights jsonb;
  w_lessons numeric; w_homework numeric; w_streak numeric; w_minutes numeric; w_no_hw_total numeric;
BEGIN
  SELECT value INTO weights FROM app_settings WHERE key = 'engagement.activity_score_weights';
  w_lessons  := COALESCE(NULLIF((weights->>'lessons'),'')::numeric, 0.4);
  w_homework := COALESCE(NULLIF((weights->>'homework'),'')::numeric, 0.3);
  w_streak   := COALESCE(NULLIF((weights->>'streak'),'')::numeric, 0.2);
  w_minutes  := COALESCE(NULLIF((weights->>'minutes'),'')::numeric, 0.1);
  w_no_hw_total := w_lessons + w_streak + w_minutes;
  IF w_no_hw_total <= 0 THEN w_no_hw_total := 0.7; END IF;

  CREATE TEMP TABLE tmp_lb ON COMMIT DROP AS
  SELECT p.id AS user_id,
    COALESCE((SELECT COUNT(*)::int FROM lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at >= now() - interval '30 days'), 0) AS lessons_30d,
    COALESCE((SELECT (SUM(total_seconds)/60)::int FROM daily_watch_summary d WHERE d.user_id = p.id AND d.watch_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 30), 0) AS minutes_30d,
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak,
    public.user_homework_avg10_effective(p.id, 30) AS avg_hw
  FROM profiles p
  WHERE p.status = 'active' AND p.archived_at IS NULL
    AND NOT has_role(p.id, 'admin'::app_role) AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(lessons_30d), 1), GREATEST(MAX(minutes_30d), 1) INTO max_lessons, max_minutes FROM tmp_lb;

  DELETE FROM leaderboard_cache;
  INSERT INTO leaderboard_cache (user_id, score, lessons_30d, minutes_30d, current_streak, rank, computed_at)
  SELECT user_id,
    LEAST(100, GREATEST(0, ROUND(
      CASE WHEN avg_hw IS NULL THEN
        ((w_lessons * (lessons_30d::numeric / max_lessons)) + (w_streak * (LEAST(current_streak,30)::numeric / 30)) + (w_minutes * (minutes_30d::numeric / max_minutes))) / w_no_hw_total * 100
      ELSE
        ((w_lessons * (lessons_30d::numeric / max_lessons)) + (w_homework * (avg_hw / 10)) + (w_streak * (LEAST(current_streak,30)::numeric / 30)) + (w_minutes * (minutes_30d::numeric / max_minutes))) * 100
      END)::int)) AS score,
    lessons_30d, minutes_30d, current_streak, NULL::int, now()
  FROM tmp_lb;

  WITH ranked AS (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY score DESC, lessons_30d DESC, current_streak DESC) AS r FROM leaderboard_cache
  )
  UPDATE leaderboard_cache lc SET rank = ranked.r FROM ranked WHERE ranked.user_id = lc.user_id;
END;
$fn$;

-- 4) RLS: block student self-grade (WITH CHECK mirrors USING).
DROP POLICY IF EXISTS "hws own update" ON public.homework_submissions;
CREATE POLICY "hws own update" ON public.homework_submissions FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id AND score IS NULL) OR has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'teacher'::app_role))
  WITH CHECK ((auth.uid() = user_id AND score IS NULL) OR has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'teacher'::app_role));

-- 5) Dedup teacher DMs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_submission_teacher_msg
  ON public.homework_teacher_dm_queue (submission_id, teacher_id, message_url)
  WHERE message_url IS NOT NULL;

-- 6) Auto-propagation cron: recompute leaderboard every 15 min (idempotent upsert by jobname).
SELECT cron.schedule('recalc-leaderboard', '*/15 * * * *', $$SELECT public.recalc_leaderboard();$$);
