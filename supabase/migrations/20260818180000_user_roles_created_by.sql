-- Record WHO created each role assignment (esp. teacher accounts).
-- user_roles gets a nullable created_by. Existing rows stay NULL = "unknown/legacy"
-- (we do NOT backfill-guess — a null simply renders as "—" in the admin UI).
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- Recreate admin_change_role so the role it inserts also stamps created_by with the
-- calling admin's auth.uid() (the function already computes `caller`). Body is otherwise
-- IDENTICAL to the current definition (migration 20260503104648): same signature, security,
-- search_path, role-tier checks, role-replace semantics, and audit_log write.
CREATE OR REPLACE FUNCTION public.admin_change_role(_target uuid, _new_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller uuid := auth.uid();
  caller_is_admin boolean;
  caller_is_super boolean;
  old_role text;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  caller_is_admin := public.has_role(caller, 'admin'::app_role);
  caller_is_super := public.has_role(caller, 'superadmin'::app_role);
  IF NOT (caller_is_admin OR caller_is_super) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  IF caller = _target THEN
    RAISE EXCEPTION 'cannot change own role';
  END IF;
  IF _new_role NOT IN ('student','teacher','admin','superadmin') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;
  IF _new_role IN ('admin','superadmin') AND NOT caller_is_super THEN
    RAISE EXCEPTION 'only superadmin can grant admin/superadmin';
  END IF;

  -- compute current "primary" role (highest)
  SELECT role::text INTO old_role
  FROM public.user_roles
  WHERE user_id = _target
  ORDER BY CASE role::text
    WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 WHEN 'teacher' THEN 3 ELSE 4 END
  LIMIT 1;
  IF old_role IS NULL THEN old_role := 'student'; END IF;

  -- replace all existing roles with the new one
  DELETE FROM public.user_roles WHERE user_id = _target;
  IF _new_role <> 'student' THEN
    INSERT INTO public.user_roles (user_id, role, created_by) VALUES (_target, _new_role::app_role, caller);
  END IF;

  INSERT INTO public.audit_log (actor_user_id, target_user_id, action, old_value, new_value)
  VALUES (caller, _target, 'change_role',
          jsonb_build_object('role', old_role),
          jsonb_build_object('role', _new_role));
END;
$$;
