-- Returns the current user's module limit for a course: NULL = full access
-- (admin/teacher, no tier, or an unlimited tier); N = only the first N modules.
-- Used by the web UI to lock modules beyond the student's tier.
CREATE OR REPLACE FUNCTION public.my_module_limit(_course_id uuid)
RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _lim int;
BEGIN
  IF public.has_role(auth.uid(),'admin'::app_role)
     OR public.has_role(auth.uid(),'superadmin'::app_role)
     OR public.has_role(auth.uid(),'teacher'::app_role) THEN
    RETURN NULL;  -- full access
  END IF;
  SELECT ct.module_limit INTO _lim
  FROM public.enrollments e
  LEFT JOIN public.course_tiers ct ON ct.id = e.tier_id
  WHERE e.user_id = auth.uid() AND e.course_id = _course_id
  LIMIT 1;
  RETURN _lim;  -- NULL = full
END;
$$;
GRANT EXECUTE ON FUNCTION public.my_module_limit(uuid) TO authenticated;
