CREATE OR REPLACE FUNCTION public.admin_group_login_stats()
 RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'teacher'::app_role)) THEN
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