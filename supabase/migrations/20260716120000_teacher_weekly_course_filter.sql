-- Course filter for the admin teacher-stats view (2026-07-16, owner request).
-- The view was global across all groups/courses, so teachers of small single-course groups
-- (e.g. Feruza @peluja_ai, PRE 5.0) looked "lowest" next to teachers running several large
-- groups. Adding p_course_id restricts to teachers assigned to that course's groups, comparing
-- like-for-like. Everything keys off the `tg` (teacher,group) CTE, so one WHERE clause scopes it.
-- Signature changes (adds a param) → drop the old (int) overload and recreate.

DROP FUNCTION IF EXISTS public.admin_teacher_weekly(int);
DROP FUNCTION IF EXISTS public.admin_teacher_weekly(int, uuid);
CREATE OR REPLACE FUNCTION public.admin_teacher_weekly(p_days int DEFAULT 7, p_course_id uuid DEFAULT NULL)
RETURNS TABLE(
  teacher_id uuid, name text, telegram_username text,
  group_id uuid, group_name text,
  active_days int, days_window int,
  active_min_by_day int[], week_active_min int,
  messages_by_day int[], week_messages int,
  questions int, answered int, answer_rate numeric, median_wait_min numeric,
  graded int, grading_med_min numeric, ungraded_backlog int,
  avg_score_pct numeric, pct_top numeric, feedback_rate numeric,
  resubmit_rate numeric, oldest_pending_hours numeric,
  last_active timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  _today date := (now() AT TIME ZONE 'Asia/Tashkent')::date;
  _from  timestamptz := now() - make_interval(days => p_days);
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
  WITH teachers AS (
    SELECT DISTINCT ur.user_id AS tid FROM user_roles ur WHERE ur.role = 'teacher'::app_role
  ),
  staff_ids AS (
    SELECT DISTINCT ur.user_id AS sid FROM user_roles ur
    WHERE ur.role IN ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  -- one (teacher, group) unit per group a teacher is assigned to that has ANY chat history (skips
  -- empty placeholder groups). t_tgid = the teacher's own telegram account (for named teachers).
  -- p_course_id (when given) restricts to that course's groups → teachers OF that course only.
  tg AS (
    SELECT g.id AS gid, g.name AS gname, g.teacher_id AS tid, p.telegram_id AS t_tgid
    FROM groups g
    JOIN teachers t ON t.tid = g.teacher_id
    JOIN profiles p ON p.id = g.teacher_id
    WHERE EXISTS (SELECT 1 FROM group_message_events e WHERE e.group_id = g.id)
      AND (p_course_id IS NULL OR g.course_id = p_course_id)
  ),
  days AS (SELECT gs::date AS d FROM generate_series(_today - (p_days - 1), _today, interval '1 day') gs),
  pair_msgs AS (
    SELECT tg.tid, tg.gid,
      (e.sent_at AT TIME ZONE 'Asia/Tashkent')::date AS d,
      e.sent_at - lag(e.sent_at) OVER (PARTITION BY tg.tid, tg.gid ORDER BY e.sent_at) AS gap
    FROM group_message_events e
    JOIN tg ON tg.gid = e.group_id
    WHERE (e.sent_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN _today - (p_days - 1) AND _today
      AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))
  ),
  pair_contrib AS (
    SELECT tid, gid, d,
      (CASE WHEN gap IS NOT NULL AND gap <= interval '10 minutes' THEN extract(epoch FROM gap) ELSE 0 END
       + CASE WHEN gap IS NULL OR gap > interval '10 minutes' THEN 60 ELSE 0 END) AS secs
    FROM pair_msgs
  ),
  pair_day AS (
    SELECT tid, gid, d, count(*)::int AS mc, round(sum(secs) / 60.0)::int AS am
    FROM pair_contrib GROUP BY tid, gid, d
  ),
  pair_grid AS (
    SELECT tg.gid, tg.tid, d.d, COALESCE(pd.am, 0) AS am, COALESCE(pd.mc, 0) AS mc
    FROM tg CROSS JOIN days d
    LEFT JOIN pair_day pd ON pd.tid = tg.tid AND pd.gid = tg.gid AND pd.d = d.d
  ),
  hours_agg AS (
    SELECT gid, tid,
      array_agg(am ORDER BY d) AS active_min_by_day,
      array_agg(mc ORDER BY d) AS messages_by_day,
      sum(am)::int AS week_active_min,
      sum(mc)::int AS week_messages,
      count(*) FILTER (WHERE mc > 0)::int AS active_days
    FROM pair_grid GROUP BY gid, tid
  ),
  dq AS (
    SELECT tg.tid, tg.gid, gme.telegram_chat_id AS chat, gme.telegram_thread_id AS thread, gme.sent_at AS q_at
    FROM group_message_events gme
    JOIN tg ON tg.gid = gme.group_id
    WHERE gme.sent_at >= _from
      AND gme.profile_id IS NOT NULL AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)
      AND (gme.mentions_teacher OR gme.has_ustoz
           OR (gme.reply_to_user_id IS NOT NULL AND gme.reply_to_user_id = tg.t_tgid))
  ),
  dq_ans AS (
    SELECT dq.tid, dq.gid, dq.q_at,
      (SELECT min(a.sent_at) FROM group_message_events a
       WHERE a.telegram_chat_id = dq.chat AND a.telegram_thread_id = dq.thread
         AND a.sent_at > dq.q_at AND a.profile_id IN (SELECT sid FROM staff_ids)) AS a_at
    FROM dq
  ),
  q_agg AS (
    SELECT tid, gid, count(*)::int AS questions,
      count(*) FILTER (WHERE a_at IS NOT NULL)::int AS answered,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a_at - q_at)) / 60.0)
            FILTER (WHERE a_at IS NOT NULL)::numeric, 1) AS median_wait_min
    FROM dq_ans GROUP BY tid, gid
  ),
  grading AS (
    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS graded,
      round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) AS grading_med_min,
      round(avg(100.0 * hs.score / NULLIF(ha.max_score, 0))::numeric, 0) AS avg_score_pct,
      round((100.0 * count(*) FILTER (WHERE hs.score = ha.max_score) / NULLIF(count(*), 0))::numeric, 0) AS pct_top,
      round((100.0 * count(*) FILTER (WHERE btrim(COALESCE(hs.score_feedback, '')) <> '') / NULLIF(count(*), 0))::numeric, 0) AS feedback_rate
    FROM homework_submissions hs
    JOIN homework_assignments ha ON ha.id = hs.assignment_id
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.scored_at >= _from AND hs.submitted_at IS NOT NULL AND hs.score IS NOT NULL
    GROUP BY g.teacher_id, g.id
  ),
  backlog AS (
    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS ungraded,
      round((EXTRACT(EPOCH FROM (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) AS oldest_pending_hours
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL
    GROUP BY g.teacher_id, g.id
  ),
  resub AS (
    SELECT g.teacher_id AS tid, g.id AS gid,
      round((100.0 * count(*) FILTER (
        WHERE COALESCE(hs.attempt_number, 1) > 1
           OR jsonb_array_length(COALESCE(hs.previous_attempts, '[]'::jsonb)) > 0
      ) / NULLIF(count(*), 0))::numeric, 0) AS resubmit_rate
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.submitted_at >= _from
    GROUP BY g.teacher_id, g.id
  ),
  lastact AS (
    SELECT tg.tid, tg.gid,
      (SELECT max(e.sent_at) FROM group_message_events e
       WHERE e.group_id = tg.gid
         AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))) AS last_active
    FROM tg
  )
  SELECT tg.tid::uuid,
    (COALESCE(NULLIF(TRIM(CONCAT(p.name, ' ', COALESCE(p.last_name, ''))), ''), p.email))::text,
    p.telegram_username::text,
    tg.gid::uuid, tg.gname::text,
    COALESCE(h.active_days, 0)::int, p_days::int,
    COALESCE(h.active_min_by_day, ARRAY[]::int[]), COALESCE(h.week_active_min, 0)::int,
    COALESCE(h.messages_by_day, ARRAY[]::int[]), COALESCE(h.week_messages, 0)::int,
    COALESCE(q.questions, 0)::int, COALESCE(q.answered, 0)::int,
    (CASE WHEN COALESCE(q.questions, 0) > 0 THEN round(100.0 * q.answered / q.questions, 0) ELSE NULL END)::numeric,
    q.median_wait_min::numeric,
    COALESCE(gr.graded, 0)::int, gr.grading_med_min::numeric, COALESCE(bl.ungraded, 0)::int,
    gr.avg_score_pct::numeric, gr.pct_top::numeric, gr.feedback_rate::numeric,
    rs.resubmit_rate::numeric, bl.oldest_pending_hours::numeric,
    la.last_active::timestamptz
  FROM tg JOIN profiles p ON p.id = tg.tid
  LEFT JOIN hours_agg h ON h.gid = tg.gid AND h.tid = tg.tid
  LEFT JOIN q_agg q ON q.gid = tg.gid AND q.tid = tg.tid
  LEFT JOIN grading gr ON gr.gid = tg.gid AND gr.tid = tg.tid
  LEFT JOIN backlog bl ON bl.gid = tg.gid AND bl.tid = tg.tid
  LEFT JOIN resub rs ON rs.gid = tg.gid AND rs.tid = tg.tid
  LEFT JOIN lastact la ON la.gid = tg.gid AND la.tid = tg.tid
  ORDER BY 2, 5;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_weekly(int, uuid) TO authenticated;
