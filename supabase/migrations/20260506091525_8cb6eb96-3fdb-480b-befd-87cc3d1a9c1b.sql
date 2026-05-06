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
  v_msg_7d int;
  v_msg_30d int;
  v_active_today int;
  v_active_7d int;
  v_active_30d int;
  v_pending int;
  v_avg numeric;
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
  SELECT count(*) INTO v_msg_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '7 days';
  SELECT count(*) INTO v_msg_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND sent_at >= now() - interval '30 days';

  SELECT count(DISTINCT profile_id) INTO v_active_today FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= date_trunc('day', (now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  SELECT count(DISTINCT profile_id) INTO v_active_7d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '7 days';
  SELECT count(DISTINCT profile_id) INTO v_active_30d FROM public.group_message_events
   WHERE group_id = p_group_id AND profile_id IS NOT NULL
     AND sent_at >= now() - interval '30 days';

  SELECT count(*) INTO v_pending
  FROM public.homework_submissions hs
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NULL;

  SELECT round(avg(CASE WHEN ha.max_score > 0 THEN 10.0 * hs.score / ha.max_score END)::numeric, 1)
  INTO v_avg
  FROM public.homework_submissions hs
  JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
  JOIN public.profiles p ON p.id = hs.user_id
  WHERE p.group_id = p_group_id AND hs.score IS NOT NULL AND ha.max_score > 0;

  RETURN json_build_object(
    'group_name', v_group_name,
    'total_students', v_total_students,
    'messages', json_build_object(
      'today', v_today,
      'last_7d', v_msg_7d,
      'last_30d', v_msg_30d
    ),
    'active_students', json_build_object(
      'today', v_active_today,
      'last_7d', v_active_7d,
      'last_30d', v_active_30d
    ),
    'pending_homework_count', v_pending,
    'avg_module_score', v_avg,
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid, uuid) TO authenticated, service_role;