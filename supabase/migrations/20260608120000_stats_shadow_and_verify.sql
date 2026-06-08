-- Workstream D · Stage 1 — INERT shadow objects + read-only verification.
-- Nothing here changes existing behavior: no triggers, no writes to leaderboard_cache,
-- no change to recalc_leaderboard or any view the app already reads. These objects exist
-- only so we can verify the corrected stats logic against live production data, read-only,
-- BEFORE any cutover. Safe to deploy.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Canonical effective homework average (0–10), mirroring src/lib/homeworkStats.ts
--    (effectiveLeafGrades + summarizeHomework). Leaf = active assignment that either
--    has a parent, or has no ACTIVE sub-assignment (SAP) children. Effective score =
--    current score, else the last scored entry in previous_attempts.
--    p_within_days = NULL → all-time (matches the displayed profile average);
--    a number → only submissions whose effective score was set within that window
--    (used by the leaderboard's 30-day activity component).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.user_homework_avg10_effective(
  p_user_id uuid,
  p_within_days int DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH active AS (
    SELECT id, parent_id, max_score
    FROM homework_assignments
    WHERE COALESCE(is_active, true) = true
  ),
  parents_with_sap AS (
    SELECT DISTINCT parent_id FROM active WHERE parent_id IS NOT NULL
  ),
  leaves AS (
    SELECT a.id, a.max_score
    FROM active a
    WHERE a.parent_id IS NOT NULL
       OR a.id NOT IN (SELECT parent_id FROM parents_with_sap)
  ),
  eff AS (
    SELECT
      l.max_score,
      -- effective score: current, else last scored previous attempt
      COALESCE(
        hs.score,
        (SELECT (e->>'score')::numeric
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb))
              WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL
           AND (e->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
         ORDER BY ord DESC
         LIMIT 1)
      ) AS effective_score,
      -- effective scored_at, for the optional time window
      COALESCE(
        hs.scored_at,
        (SELECT (e->>'scored_at')::timestamptz
         FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb))
              WITH ORDINALITY AS t(e, ord)
         WHERE NULLIF(e->>'score','') IS NOT NULL
         ORDER BY ord DESC
         LIMIT 1)
      ) AS effective_scored_at
    FROM leaves l
    JOIN homework_submissions hs
      ON hs.assignment_id = l.id AND hs.user_id = p_user_id
  )
  SELECT CASE
    WHEN COALESCE(SUM(max_score), 0) = 0 THEN NULL
    ELSE ROUND( (SUM(effective_score) / SUM(max_score)) * 10, 1)
  END
  FROM eff
  WHERE effective_score IS NOT NULL
    AND (
      p_within_days IS NULL
      OR effective_scored_at >= now() - make_interval(days => p_within_days)
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Effective module homework view — same shape intent as vw_module_homework_score,
--    but uses effective (previous_attempts-aware) scores and active-child leaf logic.
--    Read-only; the app will be repointed to it only at cutover.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.vw_module_homework_score_effective AS
WITH active AS (
  SELECT id, parent_id, max_score, module_id
  FROM homework_assignments
  WHERE COALESCE(is_active, true) = true
),
parents_with_sap AS (
  SELECT DISTINCT parent_id FROM active WHERE parent_id IS NOT NULL
),
leaves AS (
  SELECT a.id, a.max_score, a.module_id
  FROM active a
  WHERE a.parent_id IS NOT NULL
     OR a.id NOT IN (SELECT parent_id FROM parents_with_sap)
),
eff AS (
  SELECT
    hs.user_id AS profile_id,
    l.module_id,
    l.max_score,
    COALESCE(
      hs.score,
      (SELECT (e->>'score')::numeric
       FROM jsonb_array_elements(COALESCE(hs.previous_attempts, '[]'::jsonb))
            WITH ORDINALITY AS t(e, ord)
       WHERE NULLIF(e->>'score','') IS NOT NULL
         AND (e->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
       ORDER BY ord DESC LIMIT 1)
    ) AS effective_score
  FROM leaves l
  JOIN homework_submissions hs ON hs.assignment_id = l.id
)
SELECT
  profile_id,
  module_id,
  COUNT(*) FILTER (WHERE effective_score IS NOT NULL) AS scored_tasks,
  COUNT(*) AS submitted_tasks,
  SUM(effective_score) FILTER (WHERE effective_score IS NOT NULL) AS earned,
  SUM(max_score) FILTER (WHERE effective_score IS NOT NULL) AS max_scored,
  CASE WHEN COALESCE(SUM(max_score) FILTER (WHERE effective_score IS NOT NULL), 0) = 0 THEN NULL
       ELSE ROUND((SUM(effective_score) FILTER (WHERE effective_score IS NOT NULL)
                   / SUM(max_score) FILTER (WHERE effective_score IS NOT NULL)) * 10, 1)
  END AS avg10_normalized
FROM eff
GROUP BY profile_id, module_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. recalc_leaderboard_v2 — RETURNS the corrected leaderboard as a SET. It does NOT
--    write to leaderboard_cache. Identical to recalc_leaderboard EXCEPT avg_hw is the
--    normalized effective homework (30-day window) instead of raw AVG(score).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recalc_leaderboard_v2()
RETURNS TABLE(user_id uuid, score int, lessons_30d int, minutes_30d int,
              current_streak int, rank int, avg_hw numeric)
LANGUAGE plpgsql
-- VOLATILE (default): creates a TEMP TABLE, so it cannot be STABLE.
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  max_lessons int;
  max_minutes int;
  weights jsonb;
  w_lessons numeric; w_homework numeric; w_streak numeric; w_minutes numeric;
  w_no_hw_total numeric;
BEGIN
  SELECT value INTO weights FROM app_settings WHERE key = 'engagement.activity_score_weights';
  w_lessons  := COALESCE(NULLIF((weights->>'lessons'),'')::numeric, 0.4);
  w_homework := COALESCE(NULLIF((weights->>'homework'),'')::numeric, 0.3);
  w_streak   := COALESCE(NULLIF((weights->>'streak'),'')::numeric, 0.2);
  w_minutes  := COALESCE(NULLIF((weights->>'minutes'),'')::numeric, 0.1);
  w_no_hw_total := w_lessons + w_streak + w_minutes;
  IF w_no_hw_total <= 0 THEN w_no_hw_total := 0.7; END IF;

  CREATE TEMP TABLE tmp_lb2 ON COMMIT DROP AS
  SELECT
    p.id AS uid,
    COALESCE((SELECT COUNT(*)::int FROM lesson_progress lp
              WHERE lp.user_id = p.id AND lp.completed_at >= now() - interval '30 days'), 0) AS lessons_30d,
    COALESCE((SELECT (SUM(total_seconds)/60)::int FROM daily_watch_summary d
              WHERE d.user_id = p.id
                AND d.watch_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 30), 0) AS minutes_30d,
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak,
    public.user_homework_avg10_effective(p.id, 30) AS avg_hw   -- normalized, effective, 30d
  FROM profiles p
  WHERE p.status = 'active'
    AND p.archived_at IS NULL
    AND NOT has_role(p.id, 'admin'::app_role)
    AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(t.lessons_30d), 1), GREATEST(MAX(t.minutes_30d), 1)
    INTO max_lessons, max_minutes FROM tmp_lb2 t;

  RETURN QUERY
  WITH scored AS (
    SELECT
      t.uid,
      LEAST(100, GREATEST(0, ROUND(
        CASE WHEN t.avg_hw IS NULL THEN
          ((w_lessons * (t.lessons_30d::numeric / max_lessons))
           + (w_streak  * (LEAST(t.current_streak, 30)::numeric / 30))
           + (w_minutes * (t.minutes_30d::numeric / max_minutes))) / w_no_hw_total * 100
        ELSE
          ((w_lessons  * (t.lessons_30d::numeric / max_lessons))
           + (w_homework * (t.avg_hw / 10))
           + (w_streak   * (LEAST(t.current_streak, 30)::numeric / 30))
           + (w_minutes  * (t.minutes_30d::numeric / max_minutes))) * 100
        END
      )::int)) AS score,
      t.lessons_30d, t.minutes_30d, t.current_streak, t.avg_hw
    FROM tmp_lb2 t
  )
  SELECT s.uid, s.score, s.lessons_30d, s.minutes_30d, s.current_streak,
         ROW_NUMBER() OVER (ORDER BY s.score DESC, s.lessons_30d DESC, s.current_streak DESC)::int AS rank,
         s.avg_hw
  FROM scored s;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. verify_stats_parity — admin-only, READ-ONLY. For sampled active students:
--    current cache score/rank vs v2 score/rank, v2 30d-avg_hw vs displayed all-time
--    effective avg10. Lets us eyeball the corrected numbers against live data with
--    zero writes before any cutover.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_stats_parity(p_limit int DEFAULT 25)
RETURNS TABLE(
  user_id uuid,
  name text,
  cache_score int,
  v2_score int,
  score_delta int,
  cache_rank int,
  v2_rank int,
  v2_avg_hw_30d numeric,
  displayed_avg10_all_time numeric
)
LANGUAGE plpgsql
-- VOLATILE (default): calls recalc_leaderboard_v2 which creates a TEMP TABLE.
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  RETURN QUERY
  WITH v2 AS (SELECT * FROM public.recalc_leaderboard_v2())
  SELECT
    v2.user_id,
    COALESCE(NULLIF(TRIM(CONCAT(p.name,' ',p.last_name)), ''), p.email) AS name,
    lc.score AS cache_score,
    v2.score AS v2_score,
    (v2.score - COALESCE(lc.score, 0)) AS score_delta,
    lc.rank AS cache_rank,
    v2.rank AS v2_rank,
    v2.avg_hw AS v2_avg_hw_30d,
    public.user_homework_avg10_effective(v2.user_id, NULL) AS displayed_avg10_all_time
  FROM v2
  JOIN profiles p ON p.id = v2.user_id
  LEFT JOIN leaderboard_cache lc ON lc.user_id = v2.user_id
  ORDER BY ABS(v2.score - COALESCE(lc.score, 0)) DESC
  LIMIT p_limit;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. verify_rls_hws — admin-only, READ-ONLY. Confirms the homework_submissions UPDATE
--    policy now has a WITH CHECK clause (Workstream C2). Returns the policy expressions.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_rls_hws()
RETURNS TABLE(policyname name, cmd text, qual text, with_check text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
  SELECT pol.policyname, pol.cmd, pol.qual, pol.with_check
  FROM pg_policies pol
  WHERE pol.schemaname = 'public'
    AND pol.tablename = 'homework_submissions'
    AND pol.cmd = 'UPDATE';
END;
$$;
