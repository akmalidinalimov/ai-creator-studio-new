-- Harden the group-analytics SECURITY DEFINER RPCs (class fix; fan-out from the
-- admin_group_engagement_stats backlog item).
--
-- Two gaps, both live in prod:
--   (1) Caller spoofing. `v_caller := COALESCE(auth.uid(), p_caller_profile_id)` trusted a
--       caller-SUPPLIED id whenever auth.uid() was null. Because these functions were EXECUTE-able
--       by `anon` (uid null, role 'anon'), an anonymous PostgREST call could assert ANY admin/teacher
--       identity via p_caller_profile_id and read the stats. Replaced with a service-role-gated
--       resolution: real users authenticate via auth.uid(); only the trusted service_role backend
--       (the telegram webhook's /thealth + /tstats) may assert an identity via p_caller_profile_id.
--       (Precedent: security-definer-anon-guard — use auth.role()='service_role', NOT `uid is null`,
--        because anon's uid is null too.)
--   (2) No per-group ownership scope in admin_group_engagement_stats. It returned EVERY group's
--       engagement counts to ANY teacher (role check only). Now admins see all groups; a teacher sees
--       only their own (junction-aware via teacher_group_ids: primary ∪ group_teachers), and naming a
--       specific p_group_id requires admin OR is_group_teacher. teacher_group_statistics already gated
--       per-group correctly (is_group_teacher) — it only needed the caller-spoof fix.
--
-- Callers preserved (verified): frontend runs `authenticated` (auth.uid() set) → unchanged; the
-- webhook runs `service_role` (auth.uid() null) and passes p_caller_profile_id → still resolves.
-- /thealth reads only its own group's row; the teacher dashboard filters rows to its own groups
-- client-side — both are transparent to the narrower (teacher-scoped) result set.
--
-- No schema/table/type change. Function redefinitions (CREATE OR REPLACE, idempotent) + grant lockdown.

-- ============================================================================
-- 1. admin_group_engagement_stats(uuid)  — 1-arg overload
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_group_engagement_stats(p_caller_profile_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer, active_3d_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_is_admin boolean;
BEGIN
  v_caller := CASE
    WHEN auth.uid() IS NOT NULL THEN auth.uid()
    WHEN auth.role() = 'service_role' THEN p_caller_profile_id
    ELSE NULL
  END;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  v_is_admin := public.has_role(v_caller,'admin'::app_role);
  IF NOT (v_is_admin OR public.has_role(v_caller,'teacher'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT
    p.group_id,
    COUNT(*)::int AS total_active,
    COUNT(DISTINCT ae.user_id)::int AS logged_in_count,
    COUNT(DISTINCT lp.user_id)::int AS active_3d_count
  FROM public.profiles p
  LEFT JOIN public.auth_events ae
    ON ae.user_id = p.id AND ae.event = 'sign_in'
  LEFT JOIN public.lesson_progress lp
    ON lp.user_id = p.id AND lp.updated_at >= now() - interval '3 days'
  WHERE p.group_id IS NOT NULL AND p.archived_at IS NULL
    AND (v_is_admin OR p.group_id IN (SELECT public.teacher_group_ids(v_caller)))
  GROUP BY p.group_id;
END;
$function$;

-- ============================================================================
-- 2. admin_group_engagement_stats(integer, uuid, uuid)  — 3-arg overload
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_group_engagement_stats(p_window_days integer DEFAULT 3, p_caller_profile_id uuid DEFAULT NULL::uuid, p_group_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer, active_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_is_admin boolean;
  v_days int;
BEGIN
  v_caller := CASE
    WHEN auth.uid() IS NOT NULL THEN auth.uid()
    WHEN auth.role() = 'service_role' THEN p_caller_profile_id
    ELSE NULL
  END;
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  v_is_admin := public.has_role(v_caller,'admin'::app_role);
  IF NOT (v_is_admin OR public.has_role(v_caller,'teacher'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_group_id IS NOT NULL AND NOT (v_is_admin OR public.is_group_teacher(p_group_id, v_caller)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_days := GREATEST(1, LEAST(COALESCE(p_window_days, 3), 365));
  RETURN QUERY
  SELECT
    p.group_id,
    COUNT(*)::int AS total_active,
    COUNT(*) FILTER (
      WHERE EXISTS (SELECT 1 FROM public.auth_events ae WHERE ae.user_id = p.id AND ae.event = 'sign_in')
         OR p.telegram_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.bot_sessions bs WHERE bs.user_id = p.id)
    )::int AS logged_in_count,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.lesson_progress lp
        WHERE lp.user_id = p.id AND lp.updated_at >= now() - make_interval(days => v_days)
      )
    )::int AS active_count
  FROM public.profiles p
  WHERE p.group_id IS NOT NULL AND p.archived_at IS NULL
    AND (p_group_id IS NULL OR p.group_id = p_group_id)
    AND (v_is_admin OR p.group_id IN (SELECT public.teacher_group_ids(v_caller)))
  GROUP BY p.group_id;
END;
$function$;

-- ============================================================================
-- 3. teacher_group_statistics(uuid, uuid)  — caller-spoof fix ONLY.
--    Body copied verbatim from 20260818190000_group_teachers_multi.sql:293-381;
--    the ONLY change is the v_caller resolution (was COALESCE(auth.uid(), p_caller_profile_id)).
--    The per-group gate (is_group_teacher) was already correct and is unchanged.
-- ============================================================================
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

-- ============================================================================
-- Grant lockdown: remove the blanket PUBLIC + explicit anon grants; keep the
-- legitimate callers (authenticated = frontend, service_role = webhook).
-- ============================================================================
REVOKE ALL ON FUNCTION public.admin_group_engagement_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_group_engagement_stats(integer, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_group_statistics(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_group_statistics(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_group_engagement_stats(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_group_engagement_stats(integer, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_group_statistics(uuid) TO authenticated;
