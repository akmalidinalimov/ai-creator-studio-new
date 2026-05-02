CREATE OR REPLACE FUNCTION public.admin_list_users_internal()
RETURNS TABLE(id uuid, email text, name text, avatar_url text, status user_status, telegram_username citext, telegram_id bigint, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, is_admin boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT p.id, p.email, p.name, p.avatar_url, p.status, p.telegram_username, p.telegram_id,
         p.created_at, u.last_sign_in_at,
         EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin') AS is_admin
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  ORDER BY p.created_at DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_users_internal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users_internal() TO service_role;