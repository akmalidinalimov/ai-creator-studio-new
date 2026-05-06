CREATE OR REPLACE FUNCTION public.admin_group_engagement_stats(p_window_days integer DEFAULT 3, p_caller_profile_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer, active_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_days int;
BEGIN
  v_caller := COALESCE(auth.uid(), p_caller_profile_id);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT (public.has_role(v_caller,'admin'::app_role) OR public.has_role(v_caller,'teacher'::app_role)) THEN
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
  GROUP BY p.group_id;
END;
$function$;