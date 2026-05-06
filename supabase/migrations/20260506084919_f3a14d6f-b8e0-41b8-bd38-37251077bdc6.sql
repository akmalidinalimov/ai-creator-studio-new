
CREATE TABLE IF NOT EXISTS public.group_message_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE SET NULL,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  telegram_user_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  telegram_thread_id bigint,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_gme_group_sent ON public.group_message_events (group_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_gme_profile_sent ON public.group_message_events (profile_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_gme_thread ON public.group_message_events (telegram_chat_id, telegram_thread_id, sent_at DESC);

ALTER TABLE public.group_message_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gme admin read all"
  ON public.group_message_events FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "gme teacher read own groups"
  ON public.group_message_events FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'teacher'::app_role) AND EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_message_events.group_id AND g.teacher_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies: only service role (bot) writes.

CREATE OR REPLACE FUNCTION public.teacher_group_statistics(p_group_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_teacher uuid;
  v_group_name text;
  v_total_students int;
  v_today int;
  v_yesterday int;
  v_msg_7d int;
  v_msg_30d int;
  v_active_today int;
  v_active_7d int;
  v_active_30d int;
  v_silent_count int;
  v_silent_names jsonb;
  v_top jsonb;
  v_pending int;
  v_avg numeric;
  v_today_pct numeric;
  v_tz constant text := 'Asia/Tashkent';
BEGIN
  v_is_admin := has_role(auth.uid(), 'admin'::app_role);
  SELECT teacher_id, name INTO v_teacher, v_group_name FROM public.groups WHERE id = p_group_id;
  IF v_group_name IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;
  IF NOT v_is_admin AND v_teacher IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total_students
  FROM public.profiles
  WHERE group_id = p_group_id AND status = 'active';

  -- Messages
  SELECT count(*) INTO v_today FROM public.group_message_events
   WHERE group_id = p_group_id
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(*) INTO v_yesterday FROM public.group_message_events
   WHERE group_id = p_group_id
     AND sent_at >= (date_trunc('day', (now() AT TIME ZONE v_tz)) - interval '1 day') AT TIME ZONE v_tz
     AND sent_at <  date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(*) INTO v_msg_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '7 days';
  SELECT count(*) INTO v_msg_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '30 days';

  IF v_yesterday > 0 THEN
    v_today_pct := round(100.0 * (v_today - v_yesterday)::numeric / v_yesterday, 0);
  ELSE
    v_today_pct := NULL;
  END IF;

  -- Active students
  SELECT count(DISTINCT profile_id) INTO v_active_today FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(DISTINCT profile_id) INTO v_active_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL AND sent_at >= now() - interval '7 days';
  SELECT count(DISTINCT profile_id) INTO v_active_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL AND sent_at >= now() - interval '30 days';

  -- Silent students (active profile, no message in 7d)
  WITH active_ids AS (
    SELECT DISTINCT profile_id FROM public.group_message_events
     WHERE group_id = p_group_id AND profile_id IS NOT NULL
       AND sent_at >= now() - interval '7 days'
  ),
  silent AS (
    SELECT p.id, p.name, p.last_name
    FROM public.profiles p
    WHERE p.group_id = p_group_id
      AND p.status = 'active'
      AND p.id NOT IN (SELECT profile_id FROM active_ids WHERE profile_id IS NOT NULL)
  )
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object('name', name, 'last_name', last_name)
                            ORDER BY name NULLS LAST) FILTER (WHERE rn <= 5), '[]'::jsonb)
  INTO v_silent_count, v_silent_names
  FROM (SELECT s.*, row_number() OVER (ORDER BY name NULLS LAST) AS rn FROM silent s) x;

  -- Top contributors 7d
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'name', p.name, 'last_name', p.last_name, 'message_count', mc
         ) ORDER BY mc DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT profile_id, count(*) AS mc
    FROM public.group_message_events
    WHERE group_id = p_group_id AND profile_id IS NOT NULL
      AND sent_at >= now() - interval '7 days'
    GROUP BY profile_id
    ORDER BY mc DESC
    LIMIT 3
  ) m
  JOIN public.profiles p ON p.id = m.profile_id;

  -- Pending homework count for students in this group
  SELECT count(*) INTO v_pending
  FROM public.homework_submissions hs
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NULL;

  -- Average graded score (percent of max)
  SELECT round(avg(100.0 * hs.score::numeric / NULLIF(ha.max_score,0))::numeric, 1)
    INTO v_avg
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NOT NULL;

  RETURN jsonb_build_object(
    'group_name', v_group_name,
    'total_students', v_total_students,
    'messages', jsonb_build_object(
      'today', v_today,
      'yesterday', v_yesterday,
      'last_7d', v_msg_7d,
      'last_30d', v_msg_30d,
      'today_vs_yesterday_pct', v_today_pct
    ),
    'active_students', jsonb_build_object(
      'today', v_active_today,
      'today_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_today / v_total_students) ELSE 0 END,
      'last_7d', v_active_7d,
      'last_7d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_7d / v_total_students) ELSE 0 END,
      'last_30d', v_active_30d,
      'last_30d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_30d / v_total_students) ELSE 0 END
    ),
    'silent_students_7d', jsonb_build_object('count', v_silent_count, 'names', v_silent_names),
    'top_contributors_7d', v_top,
    'pending_homework_count', v_pending,
    'avg_module_score', v_avg,
    'generated_at', now()
  )::json;
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid) TO authenticated;
