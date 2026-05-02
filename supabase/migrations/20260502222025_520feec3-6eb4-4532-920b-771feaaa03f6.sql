
-- v3.0.1 — Teacher-scoped student visibility RPC

CREATE OR REPLACE FUNCTION public.get_visible_student_ids(_scope_user_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := COALESCE(_scope_user_id, auth.uid());
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;

  IF public.has_role(uid, 'admin'::app_role) THEN
    RETURN QUERY
      SELECT p.id
      FROM public.profiles p
      WHERE NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role
      );
    RETURN;
  END IF;

  IF public.has_role(uid, 'teacher'::app_role) THEN
    RETURN QUERY
      SELECT p.id
      FROM public.profiles p
      WHERE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)
        AND NOT EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = p.id AND ur.role = 'admin'::app_role
        );
    RETURN;
  END IF;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.get_visible_student_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visible_student_ids(uuid) TO authenticated, service_role;
