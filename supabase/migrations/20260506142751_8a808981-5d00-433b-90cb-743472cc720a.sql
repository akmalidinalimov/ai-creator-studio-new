
DROP FUNCTION IF EXISTS public.admin_group_login_stats();
DROP FUNCTION IF EXISTS public.admin_group_login_stats(uuid);

CREATE OR REPLACE FUNCTION public.admin_group_engagement_stats(p_caller_profile_id uuid DEFAULT NULL)
RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer, active_3d_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
BEGIN
  v_caller := COALESCE(auth.uid(), p_caller_profile_id);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT (public.has_role(v_caller,'admin'::app_role) OR public.has_role(v_caller,'teacher'::app_role)) THEN
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
  GROUP BY p.group_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_group_engagement_stats(uuid) TO authenticated, service_role;
