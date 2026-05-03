CREATE OR REPLACE FUNCTION public.group_health_score(_group_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  total int; active7 int; active_pct numeric := 0; avg_completion numeric := 0;
  avg_score numeric := 0; v_course_id uuid; total_lessons int := 0; result int;
BEGIN
  SELECT count(*) INTO total FROM public.profiles WHERE group_id = _group_id;
  IF total = 0 THEN RETURN 0; END IF;
  SELECT count(DISTINCT lp.user_id) INTO active7
    FROM public.lesson_progress lp JOIN public.profiles p ON p.id = lp.user_id
    WHERE p.group_id = _group_id AND lp.updated_at >= now() - interval '7 days';
  active_pct := (active7::numeric / total::numeric) * 100;
  SELECT g.course_id INTO v_course_id FROM public.groups g WHERE g.id = _group_id;
  IF v_course_id IS NOT NULL THEN
    SELECT count(*) INTO total_lessons FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      WHERE m.course_id = v_course_id AND l.published = true;
  END IF;
  IF total_lessons > 0 THEN
    SELECT COALESCE(avg(per_user_pct), 0) INTO avg_completion FROM (
      SELECT (count(*) FILTER (WHERE lp.completed_at IS NOT NULL)::numeric / total_lessons) * 100 AS per_user_pct
      FROM public.profiles p
      LEFT JOIN public.lesson_progress lp ON lp.user_id = p.id
      LEFT JOIN public.lessons l ON l.id = lp.lesson_id
      LEFT JOIN public.modules m ON m.id = l.module_id AND m.course_id = v_course_id
      WHERE p.group_id = _group_id GROUP BY p.id
    ) sub;
  END IF;
  SELECT COALESCE(avg(qa.score), 0) INTO avg_score FROM public.quiz_attempts qa
    JOIN public.profiles p ON p.id = qa.user_id WHERE p.group_id = _group_id;
  result := round(0.4 * LEAST(active_pct,100) + 0.4 * LEAST(avg_completion,100) + 0.2 * LEAST(avg_score,100))::int;
  RETURN GREATEST(0, LEAST(100, result));
END;
$function$;