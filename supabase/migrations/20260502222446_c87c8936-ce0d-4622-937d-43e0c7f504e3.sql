
CREATE OR REPLACE FUNCTION public.staff_recent_auth_events(_since timestamptz)
RETURNS TABLE(user_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
DECLARE is_admin_user boolean := public.has_role(uid, 'admin'::app_role);
DECLARE is_teacher_user boolean := public.has_role(uid, 'teacher'::app_role);
BEGIN
  IF NOT (is_admin_user OR is_teacher_user) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF is_admin_user THEN
    RETURN QUERY SELECT e.user_id, e.created_at FROM public.auth_events e WHERE e.created_at >= _since LIMIT 50000;
  ELSE
    RETURN QUERY
      SELECT e.user_id, e.created_at FROM public.auth_events e
      WHERE e.created_at >= _since
        AND e.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))
      LIMIT 50000;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_recent_lesson_progress(_since timestamptz)
RETURNS TABLE(user_id uuid, lesson_id uuid, updated_at timestamptz, completed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
DECLARE is_admin_user boolean := public.has_role(uid, 'admin'::app_role);
DECLARE is_teacher_user boolean := public.has_role(uid, 'teacher'::app_role);
BEGIN
  IF NOT (is_admin_user OR is_teacher_user) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF is_admin_user THEN
    RETURN QUERY SELECT lp.user_id, lp.lesson_id, lp.updated_at, lp.completed_at
                 FROM public.lesson_progress lp WHERE lp.updated_at >= _since LIMIT 100000;
  ELSE
    RETURN QUERY
      SELECT lp.user_id, lp.lesson_id, lp.updated_at, lp.completed_at
      FROM public.lesson_progress lp
      WHERE lp.updated_at >= _since
        AND lp.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))
      LIMIT 100000;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_recent_auth_events(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_recent_lesson_progress(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_recent_auth_events(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_recent_lesson_progress(timestamptz) TO authenticated, service_role;
