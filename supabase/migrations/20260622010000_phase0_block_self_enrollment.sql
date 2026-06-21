-- Phase 0 (M04): block paid-tier self-enrollment.
--
-- The previous INSERT policy let any authenticated user insert an enrollment for
-- THEMSELVES into ANY published course. Combined with has_module_access() treating
-- a NULL tier as full access, a student could self-grant unlimited access to any
-- paid course by inserting a single row. This removes the self-insert branch:
-- only admins / superadmins may INSERT enrollments via the API.
--
-- Legitimate enrollment paths are UNAFFECTED because they bypass RLS:
--   * handle_new_user()          -- SECURITY DEFINER signup trigger (default course)
--   * admin_set_enrollment_tier  -- SECURITY DEFINER admin RPC
--   * admin-create-students      -- service-role edge function
--   * AdminUsers.tsx insert       -- performed by an admin session (passes has_role)
--
-- NOTE: has_module_access() is intentionally NOT changed. "NULL tier = full access"
-- is the documented golden baseline for all ~500 existing (non-tiered) students;
-- flipping it would lock every current student out. The correct fix is to stop the
-- unauthorized row from being created in the first place.

DROP POLICY IF EXISTS "enrollments insert own or admin" ON public.enrollments;
DROP POLICY IF EXISTS "enrollments insert admin only" ON public.enrollments;

CREATE POLICY "enrollments insert admin only" ON public.enrollments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'superadmin'::app_role)
  );
