-- Teacher Statistics v2 (2026-06-19): simpler, 3 plain metrics + a weekly per-day hours row.
-- Also adds signal columns so the bot can identify questions DIRECTED at a teacher (reply / @tag /
-- "ustoz") and whether they were answered. Forward-only: past messages have these as NULL/false.

-- 1) Capture columns on group_message_events (additive, safe). Populated by the bot going forward.
ALTER TABLE public.group_message_events
  ADD COLUMN IF NOT EXISTS reply_to_message_id bigint,
  ADD COLUMN IF NOT EXISTS reply_to_user_id bigint,
  ADD COLUMN IF NOT EXISTS mentions_teacher boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_ustoz boolean NOT NULL DEFAULT false;

-- index to pair answers (reply) to questions and to scan directed questions
CREATE INDEX IF NOT EXISTS idx_gme_reply ON public.group_message_events (telegram_chat_id, reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- 2) The single, simple overview RPC the dashboard reads.
--    active_days     = days in the window with >=1 group message (chat presence)
--    hours_by_day    = int[] of "active hours" per day (distinct clock-hours with a message), oldest->newest
--    questions/...   = questions DIRECTED at the teacher (mentions_teacher OR has_ustoz OR reply-to-teacher)
--                      and whether a staff reply followed in that topic (builds up as the bot captures signals)
--    graded/...      = kept as essential context (most teachers grade rather than chat)
DROP FUNCTION IF EXISTS public.admin_teacher_weekly(int);
CREATE OR REPLACE FUNCTION public.admin_teacher_weekly(p_days int DEFAULT 7)
RETURNS TABLE(
  teacher_id uuid, name text, telegram_username text,
  active_days int, days_window int,
  hours_by_day int[], week_hours int,
  messages_by_day int[], week_messages int,
  questions int, answered int, answer_rate numeric, median_wait_min numeric,
  graded int, grading_med_min numeric, ungraded_backlog int,
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
  ttg AS (SELECT t.tid, p.telegram_id AS t_tgid FROM teachers t JOIN profiles p ON p.id = t.tid),
  days AS (SELECT gs::date AS d FROM generate_series(_today - (p_days - 1), _today, interval '1 day') gs),
  msg_raw AS (  -- every teacher group message in the window (anon msgs already carry profile_id = teacher)
    SELECT g.profile_id AS tid,
      (g.sent_at AT TIME ZONE 'Asia/Tashkent')::date AS d,
      date_trunc('hour', g.sent_at AT TIME ZONE 'Asia/Tashkent') AS hr
    FROM group_message_events g
    JOIN teachers t ON t.tid = g.profile_id
    WHERE (g.sent_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN _today - (p_days - 1) AND _today
  ),
  msg_day AS (
    SELECT tid, d, count(*)::int AS mc, count(DISTINCT hr)::int AS ah
    FROM msg_raw GROUP BY tid, d
  ),
  td AS (  -- teacher x day grid, zero-filled: ah = active clock-hours, mc = message count
    SELECT t.tid, d.d, COALESCE(m.ah, 0) AS ah, COALESCE(m.mc, 0) AS mc
    FROM teachers t CROSS JOIN days d
    LEFT JOIN msg_day m ON m.tid = t.tid AND m.d = d.d
  ),
  hours_agg AS (
    SELECT tid,
      array_agg(ah ORDER BY d) AS hours_by_day,
      array_agg(mc ORDER BY d) AS messages_by_day,
      sum(ah)::int AS week_hours,
      sum(mc)::int AS week_messages,
      count(*) FILTER (WHERE mc > 0)::int AS active_days
    FROM td GROUP BY tid
  ),
  dq AS (  -- questions directed at the group's teacher
    SELECT g.teacher_id AS tid, gme.telegram_chat_id AS chat, gme.telegram_thread_id AS thread, gme.sent_at AS q_at
    FROM group_message_events gme
    JOIN groups g ON g.id = gme.group_id AND g.teacher_id IS NOT NULL
    JOIN ttg ON ttg.tid = g.teacher_id
    WHERE gme.sent_at >= _from
      AND gme.profile_id IS NOT NULL AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)
      AND (gme.mentions_teacher OR gme.has_ustoz
           OR (gme.reply_to_user_id IS NOT NULL AND gme.reply_to_user_id = ttg.t_tgid))
  ),
  dq_ans AS (
    SELECT dq.tid, dq.q_at,
      (SELECT min(a.sent_at) FROM group_message_events a
       WHERE a.telegram_chat_id = dq.chat AND a.telegram_thread_id = dq.thread
         AND a.sent_at > dq.q_at AND a.profile_id IN (SELECT sid FROM staff_ids)) AS a_at
    FROM dq
  ),
  q_agg AS (
    SELECT tid, count(*)::int AS questions,
      count(*) FILTER (WHERE a_at IS NOT NULL)::int AS answered,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a_at - q_at)) / 60.0)
            FILTER (WHERE a_at IS NOT NULL)::numeric, 1) AS median_wait_min
    FROM dq_ans GROUP BY tid
  ),
  grading AS (
    SELECT hs.scored_by AS tid, count(*)::int AS graded,
      round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) AS grading_med_min
    FROM homework_submissions hs
    WHERE hs.scored_at >= _from AND hs.scored_by IN (SELECT tid FROM teachers) AND hs.submitted_at IS NOT NULL
    GROUP BY hs.scored_by
  ),
  backlog AS (  -- current ungraded submissions by students in the teacher's groups (not windowed)
    SELECT g.teacher_id AS tid, count(*)::int AS ungraded
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id
    WHERE g.teacher_id IN (SELECT tid FROM teachers) AND hs.score IS NULL AND hs.submitted_at IS NOT NULL
    GROUP BY g.teacher_id
  ),
  lastact AS (  -- last time the teacher did anything (group message, graded homework, or web login)
    SELECT t.tid, GREATEST(
      (SELECT max(g.sent_at)   FROM group_message_events g WHERE g.profile_id = t.tid),
      (SELECT max(h.scored_at) FROM homework_submissions h WHERE h.scored_by = t.tid),
      (SELECT max(a.created_at) FROM auth_events a WHERE a.user_id = t.tid)
    ) AS last_active
    FROM teachers t
  )
  SELECT t.tid::uuid,
    (COALESCE(NULLIF(TRIM(CONCAT(p.name, ' ', COALESCE(p.last_name, ''))), ''), p.email))::text,
    p.telegram_username::text,
    COALESCE(h.active_days, 0)::int, p_days::int,
    COALESCE(h.hours_by_day, ARRAY[]::int[]), COALESCE(h.week_hours, 0)::int,
    COALESCE(h.messages_by_day, ARRAY[]::int[]), COALESCE(h.week_messages, 0)::int,
    COALESCE(q.questions, 0)::int, COALESCE(q.answered, 0)::int,
    (CASE WHEN COALESCE(q.questions, 0) > 0 THEN round(100.0 * q.answered / q.questions, 0) ELSE NULL END)::numeric,
    q.median_wait_min::numeric,
    COALESCE(gr.graded, 0)::int, gr.grading_med_min::numeric, COALESCE(bl.ungraded, 0)::int,
    la.last_active::timestamptz
  FROM teachers t JOIN profiles p ON p.id = t.tid
  LEFT JOIN hours_agg h ON h.tid = t.tid
  LEFT JOIN q_agg q ON q.tid = t.tid
  LEFT JOIN grading gr ON gr.tid = t.tid
  LEFT JOIN backlog bl ON bl.tid = t.tid
  LEFT JOIN lastact la ON la.tid = t.tid
  ORDER BY name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_teacher_weekly(int) TO authenticated;
