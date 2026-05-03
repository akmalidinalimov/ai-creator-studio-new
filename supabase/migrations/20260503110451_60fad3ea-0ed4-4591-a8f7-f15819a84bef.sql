
DROP FUNCTION IF EXISTS public.staff_group_overview(uuid);

CREATE OR REPLACE FUNCTION public.staff_group_overview(_group_id uuid)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  teacher_id uuid,
  teacher_name text,
  course_id uuid,
  course_name text,
  created_at timestamptz,
  total_students integer,
  active_7d integer,
  avg_completion_pct integer,
  avg_score_pct integer,
  health integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  v_course_id uuid;
  v_teacher_id uuid;
  v_group_name text;
  v_course_name text;
  v_teacher_name text;
  v_created_at timestamptz;
  total_lessons int := 0;
  c int;
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT g.name, g.course_id, g.teacher_id, g.created_at
    INTO v_group_name, v_course_id, v_teacher_id, v_created_at
    FROM public.groups g WHERE g.id = _group_id;

  SELECT count(*) INTO c FROM public.profiles p WHERE p.group_id = _group_id;

  IF v_course_id IS NOT NULL THEN
    SELECT count(*) INTO total_lessons FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      WHERE m.course_id = v_course_id AND l.published = true;
    SELECT title INTO v_course_name FROM public.courses WHERE id = v_course_id;
  END IF;

  IF v_teacher_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), p.email)
      INTO v_teacher_name FROM public.profiles p WHERE p.id = v_teacher_id;
  END IF;

  RETURN QUERY
  SELECT
    _group_id,
    v_group_name,
    v_teacher_id,
    v_teacher_name,
    v_course_id,
    v_course_name,
    v_created_at,
    c AS total_students,
    (SELECT count(DISTINCT lp.user_id)::int FROM public.lesson_progress lp
      JOIN public.profiles p ON p.id = lp.user_id
      WHERE p.group_id = _group_id AND lp.updated_at >= now() - interval '7 days') AS active_7d,
    CASE WHEN c = 0 OR total_lessons = 0 THEN 0 ELSE
      (SELECT COALESCE(round(avg(per_user_pct))::int,0) FROM (
        SELECT (count(*) FILTER (WHERE lp.completed_at IS NOT NULL)::numeric / total_lessons) * 100 AS per_user_pct
        FROM public.profiles p
        LEFT JOIN public.lesson_progress lp ON lp.user_id = p.id
        LEFT JOIN public.lessons l ON l.id = lp.lesson_id
        LEFT JOIN public.modules m ON m.id = l.module_id AND m.course_id = v_course_id
        WHERE p.group_id = _group_id GROUP BY p.id
      ) s) END AS avg_completion_pct,
    (SELECT COALESCE(round(avg(qa.score))::int,0) FROM public.quiz_attempts qa
      JOIN public.profiles p ON p.id = qa.user_id WHERE p.group_id = _group_id) AS avg_score_pct,
    public.group_health_score(_group_id) AS health;
END;
$function$;
