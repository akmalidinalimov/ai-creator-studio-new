-- Phase 2 follow-up: make is_module_tier_locked's module ranking PROVABLY identical to
-- has_module_access. The prior version ranked with count(*) of (position, created_at) <= target,
-- which differs from has_module_access's ROW_NUMBER() ranking only when two modules in a course
-- share an identical (position, created_at) tuple — at such a tie on the tier boundary the two
-- gates could disagree for a TIERED student. Re-rank with the same ROW_NUMBER() so the gates match.
--
-- GOLDEN BASELINE unchanged: returns false for NULL-tier / non-enrolled / unlimited-tier / staff
-- (the enrollment+course_tiers join yields no module_limit) → inert for every 4.0 student.
CREATE OR REPLACE FUNCTION public.is_module_tier_locked(_user_id uuid, _module_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _course uuid;
  _limit int;
  _rank int;
BEGIN
  SELECT m.course_id INTO _course FROM public.modules m WHERE m.id = _module_id;
  IF _course IS NULL THEN RETURN false; END IF;

  -- Caller's tier cap for the module's course. No tiered enrollment (NULL tier, unlimited
  -- tier, or not enrolled) → NULL → not locked.
  SELECT ct.module_limit INTO _limit
  FROM public.enrollments e
  JOIN public.course_tiers ct ON ct.id = e.tier_id
  WHERE e.user_id = _user_id AND e.course_id = _course;
  IF _limit IS NULL THEN RETURN false; END IF;

  -- Same ranking as has_module_access (ROW_NUMBER over position, created_at).
  SELECT rnk INTO _rank FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at) AS rnk
    FROM public.modules WHERE course_id = _course
  ) r WHERE r.id = _module_id;

  RETURN COALESCE(_rank, 999999) > _limit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.is_module_tier_locked(uuid, uuid) TO authenticated, service_role;
