-- FIX: "set someone to teacher reverts to student" bug. ALREADY APPLIED IN
-- PRODUCTION via the Lovable SQL editor; this migration reconciles the repo.
--
-- Root cause: enforce_role_exclusivity() RAISED 'role_conflict' when a 'teacher'
-- role was inserted for a user who still had a 'student' row (student<->teacher
-- are mutually exclusive). Direct-insert assignment paths (AdminGroups "assign
-- teacher", admin-create-students, CSV import) insert teacher WITHOUT removing
-- student and swallow the error, so the user silently stayed a student. The
-- AdminUsers role dropdown worked only because its RPC (admin_change_role)
-- deletes all roles first.
--
-- Fix: instead of raising, the trigger now AUTO-REMOVES the conflicting role so
-- the newly assigned role always wins. This repairs every assignment path at
-- once. Safe against accidental demotion: no code path inserts 'student' for an
-- existing user (students get the role only at signup via handle_new_user, when
-- they have no teacher row). admin/superadmin are unaffected and may coexist.
CREATE OR REPLACE FUNCTION public.enforce_role_exclusivity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  conflicting app_role;
BEGIN
  IF NEW.role = 'student' THEN
    conflicting := 'teacher';
  ELSIF NEW.role = 'teacher' THEN
    conflicting := 'student';
  ELSE
    RETURN NEW;  -- admin / superadmin do not conflict with anything
  END IF;

  -- The newly assigned role wins: remove the conflicting role for this user.
  DELETE FROM public.user_roles
   WHERE user_id = NEW.user_id AND role = conflicting;

  RETURN NEW;
END;
$function$;

-- Trigger itself is unchanged (BEFORE INSERT OR UPDATE on public.user_roles);
-- recreated idempotently in case of a fresh DB.
DROP TRIGGER IF EXISTS trg_enforce_role_exclusivity ON public.user_roles;
CREATE TRIGGER trg_enforce_role_exclusivity
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_role_exclusivity();
