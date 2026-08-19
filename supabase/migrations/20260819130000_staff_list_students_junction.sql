-- Follow-up 1 of the teacher/co-teacher access incident class (PR #91).
--
-- staff_list_students() powers the teacher dashboard's student lists (all / never-logged-in /
-- inactive / stuck). Its teacher-scope test was PRIMARY-ONLY:
--     p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)
-- so a PURE co-teacher (a group_teachers row with is_primary=false, never the groups.teacher_id)
-- saw an EMPTY list — same class as the #86 rewrites (is_group_teacher / teacher_group_ids).
--
-- This migration copies the LATEST live definition VERBATIM
-- (src: 20260502222407_476fa22a-15a4-45b9-a513-cf7e34381132.sql:2) and changes ONLY the teachership
-- test to the junction-aware helper:
--     ... IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)
--   → ... IN (SELECT public.teacher_group_ids(uid))     -- primary ∪ group_teachers (co-teachers)
-- Signature, SECURITY DEFINER, search_path, admin/teacher gate, admin-exclusion, ORDER BY, and every
-- grant are byte-identical. Idempotent (create or replace). teacher_group_ids(uuid) is the canonical
-- helper defined in 20260818190000_group_teachers_multi.sql:55 (SECURITY DEFINER, granted to
-- authenticated, service_role) — reads groups.teacher_id UNION group_teachers.teacher_id.

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
      WHEN is_teacher_user THEN p.group_id IN (SELECT public.teacher_group_ids(uid))
      ELSE false
    END
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role)
  ORDER BY p.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_list_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_list_students() TO authenticated, service_role;
