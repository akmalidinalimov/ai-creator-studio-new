DROP FUNCTION IF EXISTS public.admin_list_users();
CREATE FUNCTION public.admin_list_users()
RETURNS TABLE(id uuid, email text, name text, avatar_url text, status user_status, telegram_username citext, telegram_id bigint, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, is_admin boolean, archived_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT p.id, p.email, p.name, p.avatar_url, p.status, p.telegram_username, p.telegram_id,
         p.created_at, u.last_sign_in_at,
         EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin') AS is_admin,
         p.archived_at
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  ORDER BY p.created_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.re_engagement_eligible_profiles()
RETURNS TABLE(id uuid, name text, last_name text, email text, telegram_id bigint, telegram_username citext, preferred_locale text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin'::app_role) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT p.id, p.name, p.last_name, p.email, p.telegram_id, p.telegram_username, p.preferred_locale
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.last_sign_in_at IS NULL
    AND p.telegram_id IS NOT NULL
    AND p.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role IN ('admin','teacher'));
END;
$function$;