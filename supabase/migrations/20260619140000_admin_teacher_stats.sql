-- Teacher Statistics — admin-only analytics for assessing teachers (2026-06-19).
-- Aggregates already-captured signals (no new tracking): group topic messages
-- (group_message_events), homework grading (homework_submissions.scored_by/scored_at),
-- and web logins (auth_events). Response time is approximated as "the next staff
-- (teacher/admin) message in the same topic after a student's message". SLA is a
-- parameter (default 120 min = 2h): a student question is "answered in time" only if a
-- staff reply landed within p_sla_min minutes.

CREATE OR REPLACE FUNCTION public.admin_teacher_stats(p_days int DEFAULT 30, p_sla_min int DEFAULT 120)
RETURNS TABLE(
  teacher_id uuid,
  name text,
  telegram_username text,
  groups_taught int,
  students int,
  active_days int,
  days_off int,
  avg_active_hours numeric,
  last_active timestamptz,
  msgs_sent int,
  questions int,
  answered_in_sla int,
  response_rate numeric,
  wait_med_min numeric,
  unanswered int,
  graded int,
  grading_med_min numeric,
  ungraded_backlog int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _from timestamptz := now() - make_interval(days => p_days);
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  RETURN QUERY
  WITH teachers AS (
    SELECT DISTINCT ur.user_id AS tid FROM user_roles ur WHERE ur.role = 'teacher'::app_role
  ),
  staff_ids AS (
    SELECT DISTINCT ur.user_id AS sid FROM user_roles ur
    WHERE ur.role IN ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  tgroups AS (  -- groups each teacher owns
    SELECT g.id AS group_id, g.teacher_id AS tid FROM groups g WHERE g.teacher_id IS NOT NULL
  ),
  gcount AS (SELECT tid, count(*)::int AS groups_taught FROM tgroups GROUP BY tid),
  gstudents AS (
    SELECT tg.tid, count(DISTINCT pr.id)::int AS students
    FROM tgroups tg JOIN profiles pr ON pr.group_id = tg.group_id AND pr.status = 'active'
    GROUP BY tg.tid
  ),
  msgs AS (
    SELECT gme.profile_id AS tid, count(*)::int AS msgs_sent
    FROM group_message_events gme
    WHERE gme.sent_at >= _from AND gme.profile_id IN (SELECT tid FROM teachers)
    GROUP BY gme.profile_id
  ),
  -- activity = any teacher signal (group message, grading, web login)
  activity AS (
    SELECT gme.profile_id AS tid, gme.sent_at AS ts
      FROM group_message_events gme
      WHERE gme.sent_at >= _from AND gme.profile_id IN (SELECT tid FROM teachers)
    UNION ALL
    SELECT hs.scored_by AS tid, hs.scored_at AS ts
      FROM homework_submissions hs
      WHERE hs.scored_at >= _from AND hs.scored_by IN (SELECT tid FROM teachers)
    UNION ALL
    SELECT ae.user_id AS tid, ae.created_at AS ts
      FROM auth_events ae
      WHERE ae.created_at >= _from AND ae.user_id IN (SELECT tid FROM teachers)
  ),
  act_agg AS (
    SELECT tid,
      count(DISTINCT (ts AT TIME ZONE 'Asia/Tashkent')::date)::int AS active_days,
      count(DISTINCT date_trunc('hour', ts AT TIME ZONE 'Asia/Tashkent'))::int AS active_hour_buckets,
      max(ts) AS last_active
    FROM activity GROUP BY tid
  ),
  grading AS (
    SELECT hs.scored_by AS tid,
      count(*)::int AS graded,
      round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) AS grading_med_min
    FROM homework_submissions hs
    WHERE hs.scored_at >= _from AND hs.scored_by IN (SELECT tid FROM teachers) AND hs.submitted_at IS NOT NULL
    GROUP BY hs.scored_by
  ),
  backlog AS (
    SELECT tg.tid, count(*)::int AS ungraded_backlog
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN tgroups tg ON tg.group_id = pr.group_id
    WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL
    GROUP BY tg.tid
  ),
  -- student QUESTIONS in each teacher's groups' DISCUSSION topics + first staff reply after.
  -- Homework topics are excluded (student posts there are submissions, not questions): both
  -- per-module topics (gme.module_id set) and the group's shared homework topic.
  qa AS (
    SELECT tg.tid,
      resp.sent_at AS a_at,
      EXTRACT(EPOCH FROM (resp.sent_at - gme.sent_at)) / 60.0 AS wait_min
    FROM group_message_events gme
    JOIN tgroups tg ON tg.group_id = gme.group_id
    JOIN groups g ON g.id = gme.group_id
    LEFT JOIN LATERAL (
      SELECT g2.sent_at FROM group_message_events g2
      WHERE g2.telegram_chat_id = gme.telegram_chat_id
        AND g2.telegram_thread_id = gme.telegram_thread_id
        AND g2.sent_at > gme.sent_at
        AND g2.profile_id IN (SELECT sid FROM staff_ids)
      ORDER BY g2.sent_at ASC LIMIT 1
    ) resp ON true
    WHERE gme.sent_at >= _from
      AND gme.telegram_thread_id IS NOT NULL
      AND gme.profile_id IS NOT NULL
      AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)   -- student message only
      AND gme.module_id IS NULL                                -- not a per-module homework topic
      AND (g.homework_topic_id IS NULL OR gme.telegram_thread_id <> g.homework_topic_id)  -- not the shared homework topic
  ),
  qa_agg AS (
    SELECT tid,
      count(*)::int AS questions,
      count(*) FILTER (WHERE a_at IS NOT NULL AND wait_min <= p_sla_min)::int AS answered_in_sla,
      -- median wait over ALL answered questions (incl. late) so a slow teacher's typical wait is honest
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min)
            FILTER (WHERE a_at IS NOT NULL)::numeric, 1) AS wait_med_min
    FROM qa GROUP BY tid
  )
  -- Explicit casts on every column so the row structure provably matches RETURNS TABLE
  -- (avoids "structure of query does not match function result type" from int/bigint/numeric drift).
  SELECT
    t.tid::uuid AS teacher_id,
    (COALESCE(NULLIF(TRIM(CONCAT(p.name, ' ', COALESCE(p.last_name, ''))), ''), p.email))::text AS name,
    p.telegram_username::text,
    COALESCE(gc.groups_taught, 0)::int,
    COALESCE(gs.students, 0)::int,
    COALESCE(aa.active_days, 0)::int,
    GREATEST(p_days - COALESCE(aa.active_days, 0), 0)::int AS days_off,
    (CASE WHEN COALESCE(aa.active_days, 0) > 0
         THEN round(aa.active_hour_buckets::numeric / aa.active_days, 1) ELSE 0 END)::numeric AS avg_active_hours,
    aa.last_active::timestamptz,
    COALESCE(m.msgs_sent, 0)::int,
    COALESCE(q.questions, 0)::int,
    COALESCE(q.answered_in_sla, 0)::int,
    (CASE WHEN COALESCE(q.questions, 0) > 0
         THEN round(100.0 * q.answered_in_sla / q.questions, 0) ELSE NULL END)::numeric AS response_rate,
    q.wait_med_min::numeric,
    (COALESCE(q.questions, 0) - COALESCE(q.answered_in_sla, 0))::int AS unanswered,
    COALESCE(gr.graded, 0)::int,
    gr.grading_med_min::numeric,
    COALESCE(bl.ungraded_backlog, 0)::int
  FROM teachers t
  JOIN profiles p ON p.id = t.tid
  LEFT JOIN gcount gc ON gc.tid = t.tid
  LEFT JOIN gstudents gs ON gs.tid = t.tid
  LEFT JOIN act_agg aa ON aa.tid = t.tid
  LEFT JOIN msgs m ON m.tid = t.tid
  LEFT JOIN grading gr ON gr.tid = t.tid
  LEFT JOIN backlog bl ON bl.tid = t.tid
  LEFT JOIN qa_agg q ON q.tid = t.tid
  ORDER BY name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_stats(int, int) TO authenticated;
