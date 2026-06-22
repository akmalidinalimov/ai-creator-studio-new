-- Teacher Statistics — per-teacher drilldown RPCs (admin-only). Companions to
-- admin_teacher_stats. Same conventions: Asia/Tashkent days, staff = teacher/admin/superadmin,
-- "questions" = student messages in DISCUSSION topics (homework topics excluded), an answer =
-- the next staff message in that topic.

-- 1) Daily activity series for the heatmap: group messages, homework graded, web logins per day.
CREATE OR REPLACE FUNCTION public.admin_teacher_activity_daily(p_teacher_id uuid, p_days int DEFAULT 30)
RETURNS TABLE(day date, group_msgs int, graded int, logins int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
  WITH days AS (
    SELECT gs::date AS day
    FROM generate_series((now() AT TIME ZONE 'Asia/Tashkent')::date - (p_days - 1),
                         (now() AT TIME ZONE 'Asia/Tashkent')::date, interval '1 day') gs
  )
  SELECT d.day,
    (SELECT count(*)::int FROM group_message_events g
       WHERE g.profile_id = p_teacher_id AND (g.sent_at AT TIME ZONE 'Asia/Tashkent')::date = d.day),
    (SELECT count(*)::int FROM homework_submissions h
       WHERE h.scored_by = p_teacher_id AND (h.scored_at AT TIME ZONE 'Asia/Tashkent')::date = d.day),
    (SELECT count(*)::int FROM auth_events a
       WHERE a.user_id = p_teacher_id AND (a.created_at AT TIME ZONE 'Asia/Tashkent')::date = d.day)
  FROM days d ORDER BY d.day;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_activity_daily(uuid, int) TO authenticated;

-- 2) Student questions in this teacher's discussion topics that went UNANSWERED within the SLA
--    (no staff reply within p_sla_min). Most recent first.
CREATE OR REPLACE FUNCTION public.admin_teacher_unanswered(p_teacher_id uuid, p_days int DEFAULT 30, p_sla_min int DEFAULT 120)
RETURNS TABLE(group_name text, student_name text, asked_at timestamptz, waited_min numeric, answered boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
  WITH staff_ids AS (
    SELECT DISTINCT ur.user_id AS sid FROM user_roles ur
    WHERE ur.role IN ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  tg AS (SELECT id, name, homework_topic_id FROM groups WHERE teacher_id = p_teacher_id)
  SELECT tg.name,
    COALESCE(NULLIF(TRIM(pr.name || ' ' || COALESCE(pr.last_name, '')), ''), pr.email, '—') AS student_name,
    gme.sent_at AS asked_at,
    round(EXTRACT(EPOCH FROM (COALESCE(resp.sent_at, now()) - gme.sent_at)) / 60.0, 0) AS waited_min,
    (resp.sent_at IS NOT NULL) AS answered
  FROM group_message_events gme
  JOIN tg ON tg.id = gme.group_id
  LEFT JOIN profiles pr ON pr.id = gme.profile_id
  LEFT JOIN LATERAL (
    SELECT g2.sent_at FROM group_message_events g2
    WHERE g2.telegram_chat_id = gme.telegram_chat_id
      AND g2.telegram_thread_id = gme.telegram_thread_id
      AND g2.sent_at > gme.sent_at
      AND g2.profile_id IN (SELECT sid FROM staff_ids)
    ORDER BY g2.sent_at ASC LIMIT 1
  ) resp ON true
  WHERE gme.sent_at >= now() - make_interval(days => p_days)
    AND gme.telegram_thread_id IS NOT NULL
    AND gme.profile_id IS NOT NULL
    AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)
    AND gme.module_id IS NULL
    AND (tg.homework_topic_id IS NULL OR gme.telegram_thread_id <> tg.homework_topic_id)
    AND (resp.sent_at IS NULL OR EXTRACT(EPOCH FROM (resp.sent_at - gme.sent_at)) / 60.0 > p_sla_min)
  ORDER BY gme.sent_at DESC
  LIMIT 100;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_unanswered(uuid, int, int) TO authenticated;

-- 3) Per-group breakdown for one teacher.
CREATE OR REPLACE FUNCTION public.admin_teacher_groups(p_teacher_id uuid, p_days int DEFAULT 30, p_sla_min int DEFAULT 120)
RETURNS TABLE(group_id uuid, group_name text, students int, questions int, answered_in_sla int,
              response_rate numeric, wait_med_min numeric, graded int, ungraded int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _from timestamptz := now() - make_interval(days => p_days);
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
  WITH staff_ids AS (
    SELECT DISTINCT ur.user_id AS sid FROM user_roles ur
    WHERE ur.role IN ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  tg AS (SELECT id, name, homework_topic_id FROM groups WHERE teacher_id = p_teacher_id),
  st AS (SELECT tg.id AS gid, count(*)::int AS students
         FROM tg JOIN profiles pr ON pr.group_id = tg.id AND pr.status = 'active' GROUP BY tg.id),
  qa AS (
    SELECT gme.group_id AS gid, resp.sent_at AS a_at,
      EXTRACT(EPOCH FROM (resp.sent_at - gme.sent_at)) / 60.0 AS wait_min
    FROM group_message_events gme
    JOIN tg ON tg.id = gme.group_id
    LEFT JOIN LATERAL (
      SELECT g2.sent_at FROM group_message_events g2
      WHERE g2.telegram_chat_id = gme.telegram_chat_id AND g2.telegram_thread_id = gme.telegram_thread_id
        AND g2.sent_at > gme.sent_at AND g2.profile_id IN (SELECT sid FROM staff_ids)
      ORDER BY g2.sent_at ASC LIMIT 1
    ) resp ON true
    WHERE gme.sent_at >= _from AND gme.telegram_thread_id IS NOT NULL
      AND gme.profile_id IS NOT NULL AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)
      AND gme.module_id IS NULL
      AND (tg.homework_topic_id IS NULL OR gme.telegram_thread_id <> tg.homework_topic_id)
  ),
  qa_agg AS (
    SELECT gid, count(*)::int AS questions,
      count(*) FILTER (WHERE a_at IS NOT NULL AND wait_min <= p_sla_min)::int AS answered_in_sla,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min)
            FILTER (WHERE a_at IS NOT NULL)::numeric, 1) AS wait_med_min
    FROM qa GROUP BY gid
  ),
  grade AS (
    SELECT pr.group_id AS gid,
      count(*) FILTER (WHERE hs.scored_by = p_teacher_id AND hs.scored_at >= _from)::int AS graded,
      count(*) FILTER (WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL)::int AS ungraded
    FROM homework_submissions hs JOIN profiles pr ON pr.id = hs.user_id
    WHERE pr.group_id IN (SELECT id FROM tg) GROUP BY pr.group_id
  )
  SELECT tg.id, tg.name,
    COALESCE(st.students, 0),
    COALESCE(q.questions, 0),
    COALESCE(q.answered_in_sla, 0),
    CASE WHEN COALESCE(q.questions, 0) > 0 THEN round(100.0 * q.answered_in_sla / q.questions, 0) ELSE NULL END,
    q.wait_med_min,
    COALESCE(gr.graded, 0),
    COALESCE(gr.ungraded, 0)
  FROM tg
  LEFT JOIN st ON st.gid = tg.id
  LEFT JOIN qa_agg q ON q.gid = tg.id
  LEFT JOIN grade gr ON gr.gid = tg.id
  ORDER BY tg.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_groups(uuid, int, int) TO authenticated;
