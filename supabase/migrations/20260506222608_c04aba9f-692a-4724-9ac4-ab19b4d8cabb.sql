CREATE OR REPLACE FUNCTION public.admin_group_module_submissions(
  p_caller_profile_id uuid DEFAULT NULL
)
RETURNS TABLE (
  group_id uuid,
  module_id uuid,
  module_position int,
  module_title text,
  total_students int,
  submitted_count int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := COALESCE(p_caller_profile_id, auth.uid());
  v_is_admin boolean := false;
  v_is_teacher boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'admin') INTO v_is_admin;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'teacher') INTO v_is_teacher;
  IF NOT (v_is_admin OR v_is_teacher) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH allowed_groups AS (
    SELECT g.id, g.course_id
    FROM public.groups g
    WHERE v_is_admin OR g.teacher_id = v_caller
  ),
  group_totals AS (
    SELECT p.group_id, COUNT(*)::int AS total_students
    FROM public.profiles p
    WHERE p.group_id IN (SELECT id FROM allowed_groups)
      AND p.archived_at IS NULL
    GROUP BY p.group_id
  ),
  group_modules AS (
    SELECT ag.id AS group_id, m.id AS module_id, m.position AS module_position, m.title AS module_title
    FROM allowed_groups ag
    JOIN public.modules m ON m.course_id = ag.course_id
  )
  SELECT
    gm.group_id,
    gm.module_id,
    gm.module_position,
    gm.module_title,
    COALESCE(gt.total_students, 0)::int AS total_students,
    (
      SELECT COUNT(DISTINCT p.id)::int
      FROM public.profiles p
      WHERE p.group_id = gm.group_id
        AND p.archived_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.homework_submissions hs
          JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
          WHERE hs.user_id = p.id
            AND ha.module_id = gm.module_id
            AND ha.is_active = true
        )
    ) AS submitted_count
  FROM group_modules gm
  LEFT JOIN group_totals gt ON gt.group_id = gm.group_id
  ORDER BY gm.group_id, gm.module_position;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_group_module_submissions(uuid) TO authenticated;