
CREATE OR REPLACE FUNCTION public.staff_list_students()
RETURNS TABLE(
  id uuid,
  email text,
  name text,
  last_name text,
  avatar_url text,
  status user_status,
  telegram_username citext,
  telegram_id bigint,
  group_id uuid,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  is_admin boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  is_admin_user boolean;
  is_teacher_user boolean;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  is_admin_user := public.has_role(uid, 'admin'::app_role);
  is_teacher_user := public.has_role(uid, 'teacher'::app_role);
  IF NOT (is_admin_user OR is_teacher_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.email, p.name, p.last_name, p.avatar_url, p.status,
    p.telegram_username, p.telegram_id, p.group_id, p.created_at,
    u.last_sign_in_at,
    EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role) AS is_admin
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE
    CASE
      WHEN is_admin_user THEN true
      WHEN is_teacher_user THEN p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)
      ELSE false
    END
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role)
  ORDER BY p.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_list_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_list_students() TO authenticated, service_role;
