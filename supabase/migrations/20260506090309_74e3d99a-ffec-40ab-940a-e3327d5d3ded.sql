CREATE OR REPLACE FUNCTION public.teacher_group_statistics(p_group_id uuid, p_caller_profile_id uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
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
  v_caller := COALESCE(auth.uid(), p_caller_profile_id);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  v_is_admin := has_role(v_caller, 'admin'::app_role);
  SELECT teacher_id, name INTO v_teacher, v_group_name FROM public.groups WHERE id = p_group_id;
  IF v_group_name IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;
  IF NOT v_is_admin AND (v_teacher IS NULL OR v_teacher <> v_caller) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total_students
  FROM public.profiles
  WHERE group_id = p_group_id AND status = 'active';

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

  v_today_pct := CASE WHEN v_yesterday > 0 THEN round(100.0 * (v_today - v_yesterday) / v_yesterday, 0) ELSE NULL END;

  SELECT count(DISTINCT profile_id) INTO v_active_today FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(DISTINCT profile_id) INTO v_active_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '7 days';
  SELECT count(DISTINCT profile_id) INTO v_active_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '30 days';

  SELECT count(*) INTO v_silent_count
  FROM public.profiles p
  WHERE p.group_id = p_group_id AND p.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.group_message_events e
      WHERE e.group_id = p_group_id AND e.profile_id = p.id
        AND e.sent_at >= now() - interval '7 days'
    );

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'last_name', p.last_name) ORDER BY p.name), '[]'::jsonb)
  INTO v_silent_names
  FROM (
    SELECT p.id, p.name, p.last_name
    FROM public.profiles p
    WHERE p.group_id = p_group_id AND p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM public.group_message_events e
        WHERE e.group_id = p_group_id AND e.profile_id = p.id
          AND e.sent_at >= now() - interval '7 days'
      )
    ORDER BY p.name
    LIMIT 5
  ) p;

  SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'message_count')::int DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'last_name', p.last_name,
      'message_count', count(*)::int
    ) AS t
    FROM public.group_message_events e
    JOIN public.profiles p ON p.id = e.profile_id
    WHERE e.group_id = p_group_id AND e.profile_id IS NOT NULL
      AND e.sent_at >= now() - interval '7 days'
    GROUP BY p.id, p.name, p.last_name
    ORDER BY count(*) DESC
    LIMIT 3
  ) s;

  SELECT count(*) INTO v_pending
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.student_id
  WHERE p.group_id = p_group_id AND hs.score IS NULL;

  SELECT round(avg(CASE WHEN ha.max_score > 0 THEN 100.0 * hs.score / ha.max_score END)::numeric, 0)
  INTO v_avg
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.student_id
  WHERE p.group_id = p_group_id AND hs.score IS NOT NULL AND ha.max_score > 0;

  RETURN json_build_object(
    'group_name', v_group_name,
    'total_students', v_total_students,
    'messages', json_build_object(
      'today', v_today,
      'yesterday', v_yesterday,
      'today_vs_yesterday_pct', v_today_pct,
      'last_7d', v_msg_7d,
      'last_30d', v_msg_30d
    ),
    'active_students', json_build_object(
      'today', v_active_today,
      'today_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_today / v_total_students, 0) ELSE 0 END,
      'last_7d', v_active_7d,
      'last_7d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_7d / v_total_students, 0) ELSE 0 END,
      'last_30d', v_active_30d,
      'last_30d_pct', CASE WHEN v_total_students > 0 THEN round(100.0 * v_active_30d / v_total_students, 0) ELSE 0 END
    ),
    'silent_students_7d', json_build_object('count', v_silent_count, 'names', v_silent_names),
    'top_contributors_7d', v_top,
    'pending_homework_count', v_pending,
    'avg_module_score', v_avg
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid, uuid) TO authenticated, service_role;