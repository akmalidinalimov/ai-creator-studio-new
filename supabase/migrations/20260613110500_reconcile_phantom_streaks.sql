-- One-time reconcile (owner decision 2026-06-13: reset corrupted streaks, KEEP
-- badges, send NO DMs). Recomputes current_streak/last_active_date from genuine
-- activity (had_genuine_activity_on_date) over the last 45 days, so phantom
-- streaks built from 0-second lesson opens are corrected. Badge-DM trigger is
-- disabled around the update so no recognition messages fire.
ALTER TABLE public.user_badges DISABLE TRIGGER trg_queue_badge_dm;

WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date AS d),
days AS (
  SELECT s.user_id, gs.d::date AS day,
         public.had_genuine_activity_on_date(s.user_id, gs.d::date) AS act
  FROM public.streaks s
  CROSS JOIN LATERAL generate_series(
    (SELECT d FROM today) - 44, (SELECT d FROM today), interval '1 day') AS gs(d)
),
last_g AS (
  SELECT user_id, max(day) FILTER (WHERE act) AS last_day
  FROM days GROUP BY user_id
),
run AS (
  SELECT lg.user_id, lg.last_day,
    CASE WHEN lg.last_day IS NULL THEN 0
    ELSE (
      SELECT count(*) FROM days d2
      WHERE d2.user_id = lg.user_id AND d2.act AND d2.day <= lg.last_day
        AND d2.day > COALESCE(
          (SELECT max(d3.day) FROM days d3
             WHERE d3.user_id = lg.user_id AND NOT d3.act AND d3.day <= lg.last_day),
          (SELECT d FROM today) - 45)
    ) END AS run_len
  FROM last_g lg
)
UPDATE public.streaks s
SET
  last_active_date = run.last_day,
  current_streak = CASE
     WHEN run.last_day IS NULL THEN 0
     WHEN run.last_day < (SELECT d FROM today) - 1 THEN 0   -- broken: last genuine day older than yesterday
     ELSE run.run_len
   END,
  longest_streak = GREATEST(COALESCE(s.longest_streak, 0),
                            CASE WHEN run.last_day IS NULL THEN 0 ELSE run.run_len END)
FROM run
WHERE run.user_id = s.user_id;

ALTER TABLE public.user_badges ENABLE TRIGGER trg_queue_badge_dm;
