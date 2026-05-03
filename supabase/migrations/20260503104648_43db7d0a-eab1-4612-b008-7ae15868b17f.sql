-- 1) Fix ambiguous course_id in staff_group_overview by renaming local var
CREATE OR REPLACE FUNCTION public.staff_group_overview(_group_id uuid)
 RETURNS TABLE(total integer, active_7d integer, completion_pct integer, avg_score integer, health integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  v_course_id uuid;
  total_lessons int := 0;
  c int;
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT count(*) INTO c FROM public.profiles p WHERE p.group_id = _group_id;
  SELECT g.course_id INTO v_course_id FROM public.groups g WHERE g.id = _group_id;
  IF v_course_id IS NOT NULL THEN
    SELECT count(*) INTO total_lessons FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      WHERE m.course_id = v_course_id AND l.published = true;
  END IF;
  RETURN QUERY
  SELECT
    c AS total,
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
      ) s) END AS completion_pct,
    (SELECT COALESCE(round(avg(qa.score))::int,0) FROM public.quiz_attempts qa
      JOIN public.profiles p ON p.id = qa.user_id WHERE p.group_id = _group_id) AS avg_score,
    public.group_health_score(_group_id) AS health;
END;
$function$;

-- 2) admin_change_role RPC (security-definer with role-tier checks)
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
    INSERT INTO public.user_roles (user_id, role) VALUES (_target, _new_role::app_role);
  END IF;

  INSERT INTO public.audit_log (actor_user_id, target_user_id, action, old_value, new_value)
  VALUES (caller, _target, 'change_role',
          jsonb_build_object('role', old_role),
          jsonb_build_object('role', _new_role));
END;
$$;