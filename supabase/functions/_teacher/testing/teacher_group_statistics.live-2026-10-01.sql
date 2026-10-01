-- GENERATED from the repo migrations that last defined each function (teacher-waiting-rule-check.ts asserts
-- every body's md5, CRs stripped, equals production's md5(replace(prosrc, CR, '')) read on 2026-10-01).
-- Do not edit by hand. Fixture only; never applied to a real database.

-- teacher_group_statistics(uuid): from 20260818190000_group_teachers_multi.sql; body md5 5dd42fce227c1070a9c4829e426b1e69
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
  IF NOT (v_is_admin OR public.is_group_teacher(p_group_id, auth.uid())) THEN
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


-- teacher_group_statistics(uuid, uuid): from 20260820090000_harden_group_analytics_rpcs.sql; body md5 41792ee8bb9e733c7784d691d694685c
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
  v_caller := CASE
    WHEN auth.uid() IS NOT NULL THEN auth.uid()
    WHEN auth.role() = 'service_role' THEN p_caller_profile_id
    ELSE NULL
  END;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  v_is_admin := has_role(v_caller, 'admin'::app_role);
  SELECT teacher_id, name INTO v_teacher, v_group_name FROM public.groups WHERE id = p_group_id;
  IF v_group_name IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;
  IF NOT (v_is_admin OR public.is_group_teacher(p_group_id, v_caller)) THEN
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

