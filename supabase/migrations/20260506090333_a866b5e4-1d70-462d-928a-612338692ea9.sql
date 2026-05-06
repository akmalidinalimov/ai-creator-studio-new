CREATE OR REPLACE FUNCTION public.admin_group_login_stats(p_caller_profile_id uuid DEFAULT NULL)
 RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT p.group_id,
         COUNT(*)::int AS total_active,
         COUNT(u.last_sign_in_at)::int AS logged_in_count
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.group_id IS NOT NULL
  GROUP BY p.group_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_group_login_stats(uuid) TO authenticated, service_role;