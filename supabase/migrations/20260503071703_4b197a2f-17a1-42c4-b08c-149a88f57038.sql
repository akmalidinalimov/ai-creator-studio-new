
-- ============================================================
-- v3.4 Analytics: materialized views + RPCs
-- ============================================================

-- ---------- 1. Funnel ----------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_funnel_stages AS
WITH
  registered AS (
    SELECT id, created_at FROM public.profiles
  ),
  logged_in AS (
    SELECT DISTINCT user_id FROM public.auth_events WHERE event = 'sign_in'
  ),
  watched_30s AS (
    SELECT DISTINCT user_id FROM public.lesson_progress
    WHERE COALESCE(watch_seconds_total, 0) >= 30 OR COALESCE(seconds_watched, 0) >= 30
  ),
  completed_per_user_module AS (
    SELECT lp.user_id, m.position AS mod_pos, COUNT(DISTINCT lp.lesson_id) AS done,
           (SELECT COUNT(*) FROM public.lessons l2 WHERE l2.module_id = m.id AND l2.published) AS total_lessons
      FROM public.lesson_progress lp
      JOIN public.lessons l ON l.id = lp.lesson_id AND l.published
      JOIN public.modules m ON m.id = l.module_id
      JOIN public.courses c ON c.id = m.course_id AND c.published
     WHERE lp.completed_at IS NOT NULL
     GROUP BY lp.user_id, m.id, m.position
  ),
  finished_module AS (
    SELECT user_id, mod_pos
      FROM completed_per_user_module
     WHERE done >= GREATEST(total_lessons, 1)
  ),
  finished_m1 AS (SELECT DISTINCT user_id FROM finished_module WHERE mod_pos = 1),
  finished_m3 AS (
    SELECT user_id FROM finished_module WHERE mod_pos <= 3
    GROUP BY user_id HAVING COUNT(DISTINCT mod_pos) >= 3
  ),
  finished_all AS (
    SELECT user_id FROM finished_module
    GROUP BY user_id
   HAVING COUNT(DISTINCT mod_pos) >= (
     SELECT COUNT(DISTINCT m.position)
       FROM public.modules m JOIN public.courses c ON c.id = m.course_id AND c.published
   )
  )
SELECT
  1 AS stage_order, 'registered' AS stage_key, (SELECT COUNT(*) FROM registered) AS users
UNION ALL SELECT 2, 'logged_in',     (SELECT COUNT(*) FROM logged_in)
UNION ALL SELECT 3, 'watched_30s',   (SELECT COUNT(*) FROM watched_30s)
UNION ALL SELECT 4, 'finished_m1',   (SELECT COUNT(*) FROM finished_m1)
UNION ALL SELECT 5, 'finished_m3',   (SELECT COUNT(*) FROM finished_m3)
UNION ALL SELECT 6, 'finished_all',  (SELECT COUNT(*) FROM finished_all);

CREATE UNIQUE INDEX IF NOT EXISTS mv_funnel_stages_pk ON public.mv_funnel_stages (stage_order);

-- ---------- 2. Cohort retention (week of registration × week offset) ----------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_cohort_retention AS
WITH
  cohort AS (
    SELECT id AS user_id,
           date_trunc('week', created_at)::date AS cohort_week
      FROM public.profiles
  ),
  activity AS (
    SELECT user_id, date_trunc('week', updated_at)::date AS active_week FROM public.lesson_progress
    UNION
    SELECT user_id, date_trunc('week', created_at)::date FROM public.auth_events
  ),
  cohort_size AS (
    SELECT cohort_week, COUNT(*) AS size FROM cohort GROUP BY cohort_week
  ),
  joined AS (
    SELECT c.cohort_week,
           ((a.active_week - c.cohort_week) / 7)::int AS week_offset,
           COUNT(DISTINCT c.user_id) AS active_users
      FROM cohort c
      JOIN activity a ON a.user_id = c.user_id AND a.active_week >= c.cohort_week
     GROUP BY c.cohort_week, week_offset
  )
SELECT j.cohort_week,
       j.week_offset,
       j.active_users,
       cs.size AS cohort_size,
       ROUND((j.active_users::numeric / NULLIF(cs.size, 0)) * 100, 1) AS retention_pct
  FROM joined j
  JOIN cohort_size cs USING (cohort_week)
 WHERE j.week_offset BETWEEN 0 AND 11;

CREATE UNIQUE INDEX IF NOT EXISTS mv_cohort_retention_pk ON public.mv_cohort_retention (cohort_week, week_offset);

-- ---------- 3. Per-lesson dropoff ----------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_lesson_dropoff AS
WITH
  base AS (
    SELECT l.id AS lesson_id, l.title AS lesson_title, l.position AS lesson_pos,
           m.id AS module_id, m.title AS module_title, m.position AS module_pos,
           l.duration_seconds
      FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      JOIN public.courses c ON c.id = m.course_id AND c.published
     WHERE l.published
  ),
  starts AS (
    SELECT lesson_id, COUNT(DISTINCT user_id) AS starts
      FROM public.lesson_progress
     WHERE COALESCE(watch_seconds_total, 0) >= 5 OR COALESCE(seconds_watched, 0) >= 5
     GROUP BY lesson_id
  ),
  completes AS (
    SELECT lesson_id, COUNT(DISTINCT user_id) AS completes
      FROM public.lesson_progress
     WHERE completed_at IS NOT NULL
     GROUP BY lesson_id
  ),
  positions AS (
    SELECT lp.lesson_id,
           LEAST(9, GREATEST(0,
             FLOOR(
               (GREATEST(COALESCE(lp.max_position_seconds, 0), COALESCE(lp.last_position_seconds, 0))::numeric)
               / NULLIF(b.duration_seconds, 0) * 10
             )::int
           )) AS bucket
      FROM public.lesson_progress lp
      JOIN base b ON b.lesson_id = lp.lesson_id
     WHERE COALESCE(b.duration_seconds, 0) > 0
       AND (COALESCE(lp.watch_seconds_total, 0) >= 5 OR COALESCE(lp.seconds_watched, 0) >= 5)
  ),
  hist AS (
    SELECT lesson_id,
           jsonb_object_agg(bucket::text, cnt) AS histogram
      FROM (
        SELECT lesson_id, bucket, COUNT(*) AS cnt FROM positions GROUP BY lesson_id, bucket
      ) g
      GROUP BY lesson_id
  )
SELECT b.lesson_id,
       b.lesson_title,
       b.lesson_pos,
       b.module_id,
       b.module_title,
       b.module_pos,
       COALESCE(s.starts, 0)        AS starts,
       COALESCE(c.completes, 0)     AS completes,
       CASE WHEN COALESCE(s.starts, 0) > 0
            THEN ROUND(c.completes::numeric / s.starts * 100, 1)
            ELSE 0 END              AS completion_rate,
       COALESCE(h.histogram, '{}'::jsonb) AS histogram
  FROM base b
  LEFT JOIN starts s    ON s.lesson_id = b.lesson_id
  LEFT JOIN completes c ON c.lesson_id = b.lesson_id
  LEFT JOIN hist h      ON h.lesson_id = b.lesson_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_lesson_dropoff_pk ON public.mv_lesson_dropoff (lesson_id);

-- ---------- 4. Study heatmap (Tashkent day × hour, 30d) ----------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_study_heatmap_30d AS
WITH base AS (
  SELECT
    /* Postgres: 0=Sunday..6=Saturday. Convert to Mon=0..Sun=6. */
    ((EXTRACT(DOW FROM (lp.updated_at AT TIME ZONE 'Asia/Tashkent'))::int + 6) % 7) AS dow,
    EXTRACT(HOUR FROM (lp.updated_at AT TIME ZONE 'Asia/Tashkent'))::int AS hour,
    COALESCE(lp.watch_seconds_total, 0) AS secs
  FROM public.lesson_progress lp
  WHERE lp.updated_at >= now() - interval '30 days'
)
SELECT dow, hour, ROUND(SUM(secs)::numeric / 60, 1) AS minutes
  FROM base
 GROUP BY dow, hour;

CREATE UNIQUE INDEX IF NOT EXISTS mv_study_heatmap_30d_pk ON public.mv_study_heatmap_30d (dow, hour);

-- Initial populate
REFRESH MATERIALIZED VIEW public.mv_funnel_stages;
REFRESH MATERIALIZED VIEW public.mv_cohort_retention;
REFRESH MATERIALIZED VIEW public.mv_lesson_dropoff;
REFRESH MATERIALIZED VIEW public.mv_study_heatmap_30d;

-- ---------- Read access (admin-only via RPC) ----------
-- The MVs are not exposed via REST. We provide SECURITY DEFINER RPCs.

CREATE OR REPLACE FUNCTION public.analytics_funnel()
RETURNS TABLE(stage_order int, stage_key text, users bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT stage_order, stage_key, users FROM public.mv_funnel_stages
   WHERE has_role(auth.uid(), 'admin'::app_role)
   ORDER BY stage_order;
$$;

CREATE OR REPLACE FUNCTION public.analytics_cohorts()
RETURNS TABLE(cohort_week date, week_offset int, active_users bigint, cohort_size bigint, retention_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cohort_week, week_offset, active_users, cohort_size, retention_pct
    FROM public.mv_cohort_retention
   WHERE has_role(auth.uid(), 'admin'::app_role)
   ORDER BY cohort_week DESC, week_offset ASC;
$$;

CREATE OR REPLACE FUNCTION public.analytics_lesson_dropoff()
RETURNS TABLE(lesson_id uuid, lesson_title text, lesson_pos int, module_id uuid, module_title text, module_pos int, starts bigint, completes bigint, completion_rate numeric, histogram jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lesson_id, lesson_title, lesson_pos, module_id, module_title, module_pos,
         starts, completes, completion_rate, histogram
    FROM public.mv_lesson_dropoff
   WHERE has_role(auth.uid(), 'admin'::app_role)
   ORDER BY completion_rate ASC, starts DESC;
$$;

CREATE OR REPLACE FUNCTION public.analytics_heatmap()
RETURNS TABLE(dow int, hour int, minutes numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dow, hour, minutes FROM public.mv_study_heatmap_30d
   WHERE has_role(auth.uid(), 'admin'::app_role);
$$;

CREATE OR REPLACE FUNCTION public.analytics_teacher_quality(_min_students int DEFAULT 5)
RETURNS TABLE(
  teacher_id uuid,
  teacher_name text,
  teacher_email text,
  students_count bigint,
  active_7d_pct numeric,
  avg_completion_pct numeric,
  avg_homework_score numeric,
  finished_course bigint,
  quality_score numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH
    teachers AS (
      SELECT g.teacher_id, g.id AS group_id
        FROM public.groups g
       WHERE g.teacher_id IS NOT NULL
    ),
    members AS (
      SELECT t.teacher_id, p.id AS user_id
        FROM teachers t
        JOIN public.profiles p ON p.group_id = t.group_id
    ),
    teacher_students AS (
      SELECT teacher_id, COUNT(DISTINCT user_id) AS students_count FROM members GROUP BY teacher_id
    ),
    active_7d AS (
      SELECT m.teacher_id, COUNT(DISTINCT lp.user_id) AS active_count
        FROM members m
        JOIN public.lesson_progress lp ON lp.user_id = m.user_id
       WHERE lp.updated_at >= now() - interval '7 days'
       GROUP BY m.teacher_id
    ),
    total_pub_lessons AS (
      SELECT COUNT(*)::numeric AS n
        FROM public.lessons l
        JOIN public.modules mo ON mo.id = l.module_id
        JOIN public.courses c ON c.id = mo.course_id AND c.published
       WHERE l.published
    ),
    user_completion AS (
      SELECT m.teacher_id, m.user_id,
             COUNT(DISTINCT lp.lesson_id) FILTER (WHERE lp.completed_at IS NOT NULL) AS done
        FROM members m
        LEFT JOIN public.lesson_progress lp ON lp.user_id = m.user_id
        GROUP BY m.teacher_id, m.user_id
    ),
    completion_avg AS (
      SELECT teacher_id,
             ROUND(AVG(LEAST(done::numeric / NULLIF((SELECT n FROM total_pub_lessons), 0), 1) * 100), 1) AS avg_completion_pct,
             COUNT(*) FILTER (WHERE done >= (SELECT n FROM total_pub_lessons)) AS finished_course
        FROM user_completion
       GROUP BY teacher_id
    ),
    hw AS (
      SELECT m.teacher_id, ROUND(AVG(hs.score)::numeric, 2) AS avg_hw
        FROM members m
        JOIN public.homework_submissions hs ON hs.user_id = m.user_id
       WHERE hs.score IS NOT NULL
       GROUP BY m.teacher_id
    ),
    profs AS (
      SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', name, last_name)), ''), email) AS teacher_name, email
        FROM public.profiles
    )
  SELECT
    ts.teacher_id,
    pr.teacher_name,
    pr.email AS teacher_email,
    ts.students_count,
    ROUND(COALESCE(ac.active_count, 0)::numeric / NULLIF(ts.students_count, 0) * 100, 1) AS active_7d_pct,
    COALESCE(ca.avg_completion_pct, 0) AS avg_completion_pct,
    COALESCE(hw.avg_hw, 0) AS avg_homework_score,
    COALESCE(ca.finished_course, 0) AS finished_course,
    /* composite: 40% completion, 30% activity, 20% homework, 10% finishers */
    ROUND(
      COALESCE(ca.avg_completion_pct, 0) * 0.4
      + COALESCE(ac.active_count::numeric / NULLIF(ts.students_count, 0) * 100, 0) * 0.3
      + COALESCE(hw.avg_hw, 0) * 10 * 0.2
      + LEAST(COALESCE(ca.finished_course, 0)::numeric / NULLIF(ts.students_count, 0) * 100, 100) * 0.1
    , 1) AS quality_score
  FROM teacher_students ts
  LEFT JOIN active_7d ac ON ac.teacher_id = ts.teacher_id
  LEFT JOIN completion_avg ca ON ca.teacher_id = ts.teacher_id
  LEFT JOIN hw ON hw.teacher_id = ts.teacher_id
  LEFT JOIN profs pr ON pr.id = ts.teacher_id
  WHERE has_role(auth.uid(), 'admin'::app_role)
    AND ts.students_count >= COALESCE(_min_students, 5)
  ORDER BY quality_score DESC NULLS LAST;
$$;

-- Online-now (last 5 min) — admin-only count
CREATE OR REPLACE FUNCTION public.online_now_count()
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN has_role(auth.uid(), 'admin'::app_role) THEN
    (SELECT COUNT(DISTINCT user_id)::int FROM public.lesson_progress WHERE updated_at >= now() - interval '5 minutes')
  ELSE 0 END;
$$;

-- Refresh wrapper, callable from cron via http_post or directly
CREATE OR REPLACE FUNCTION public.refresh_all_analytics()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_funnel_stages;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_cohort_retention;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_lesson_dropoff;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_study_heatmap_30d;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_all_analytics() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_all_analytics() TO service_role;

GRANT EXECUTE ON FUNCTION public.analytics_funnel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_cohorts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_lesson_dropoff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_heatmap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_teacher_quality(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.online_now_count() TO authenticated;

-- Schedule nightly refresh at 03:00 Tashkent (= 22:00 UTC)
DO $$
BEGIN
  PERFORM cron.unschedule('refresh_all_analytics');
EXCEPTION WHEN others THEN NULL;
END $$;

SELECT cron.schedule(
  'refresh_all_analytics',
  '0 22 * * *',
  $cron$ SELECT public.refresh_all_analytics(); $cron$
);
