-- Per-course Tiers. A course can be NON-TIERED (no rows here = every enrolled
-- student gets all modules = today's behavior) or have named tiers, each granting
-- the first N modules (by order). NULL module_limit = all modules.
CREATE TABLE IF NOT EXISTS public.course_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name text NOT NULL,
  module_limit int,                       -- NULL = all modules; N = first N modules
  position int NOT NULL DEFAULT 0,        -- display order
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_course_tier_limit CHECK (module_limit IS NULL OR module_limit >= 1)
);
CREATE INDEX IF NOT EXISTS idx_course_tiers_course ON public.course_tiers(course_id, position);
ALTER TABLE public.course_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "course_tiers read" ON public.course_tiers;
CREATE POLICY "course_tiers read" ON public.course_tiers
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "course_tiers admin write" ON public.course_tiers;
CREATE POLICY "course_tiers admin write" ON public.course_tiers
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role));

-- Link an enrollment to a tier. NULL = full access (non-tiered course, or the
-- top "all" tier). If a tier is deleted, affected enrollments fall back to NULL
-- (full access) rather than erroring.
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS tier_id uuid REFERENCES public.course_tiers(id) ON DELETE SET NULL;

-- Access check: admin/teacher always; else the student must be enrolled in the
-- module's course, and (no tier / unlimited tier) OR the module is within the
-- first `module_limit` modules (ranked by order, robust to position numbering).
CREATE OR REPLACE FUNCTION public.has_module_access(_user_id uuid, _module_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _course uuid;
  _limit int;
  _enrolled boolean := false;
  _rank int;
BEGIN
  IF public.has_role(_user_id,'admin'::app_role)
     OR public.has_role(_user_id,'superadmin'::app_role)
     OR public.has_role(_user_id,'teacher'::app_role) THEN
    RETURN true;
  END IF;

  SELECT course_id INTO _course FROM public.modules WHERE id = _module_id;
  IF _course IS NULL THEN RETURN false; END IF;

  SELECT true, ct.module_limit INTO _enrolled, _limit
  FROM public.enrollments e
  LEFT JOIN public.course_tiers ct ON ct.id = e.tier_id
  WHERE e.user_id = _user_id AND e.course_id = _course
  LIMIT 1;

  IF NOT COALESCE(_enrolled, false) THEN RETURN false; END IF;
  IF _limit IS NULL THEN RETURN true; END IF;   -- no tier, or unlimited tier

  SELECT rnk INTO _rank FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at) AS rnk
    FROM public.modules WHERE course_id = _course
  ) r WHERE r.id = _module_id;

  RETURN COALESCE(_rank, 999999) <= _limit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.has_module_access(uuid, uuid) TO authenticated;

-- Admin sets/clears a student's tier for a course (upserts the enrollment).
CREATE OR REPLACE FUNCTION public.admin_set_enrollment_tier(
  _user_id uuid, _course_id uuid, _tier_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  -- tier (if given) must belong to the course
  IF _tier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.course_tiers WHERE id = _tier_id AND course_id = _course_id
  ) THEN
    RAISE EXCEPTION 'tier does not belong to course';
  END IF;
  INSERT INTO public.enrollments (user_id, course_id, tier_id)
  VALUES (_user_id, _course_id, _tier_id)
  ON CONFLICT (user_id, course_id) DO UPDATE SET tier_id = EXCLUDED.tier_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_set_enrollment_tier(uuid, uuid, uuid) TO authenticated;
