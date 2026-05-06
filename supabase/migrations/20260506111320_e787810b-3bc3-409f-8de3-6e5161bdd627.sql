
CREATE OR REPLACE FUNCTION public.enforce_role_exclusivity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  conflicting app_role;
BEGIN
  IF NEW.role = 'student' THEN
    conflicting := 'teacher';
  ELSIF NEW.role = 'teacher' THEN
    conflicting := 'student';
  ELSE
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id
      AND role = conflicting
  ) THEN
    RAISE EXCEPTION 'role_conflict: user % already has role %, cannot also be %',
      NEW.user_id, conflicting, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_role_exclusivity ON public.user_roles;
CREATE TRIGGER trg_enforce_role_exclusivity
BEFORE INSERT OR UPDATE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_role_exclusivity();
