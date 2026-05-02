-- Add 'superadmin' to app_role
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'superadmin';

-- audit_log table
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  target_user_id uuid,
  action text NOT NULL,
  old_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log admin read" ON public.audit_log;
CREATE POLICY "audit_log admin read" ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON public.audit_log (target_user_id);

-- groups.is_default
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS groups_one_default_idx ON public.groups (is_default) WHERE is_default = true;

-- Access guard: caller can see this group?
CREATE OR REPLACE FUNCTION public.can_see_group(_group_id uuid, _uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT
    public.has_role(_uid,'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = _group_id AND g.teacher_id = _uid);
$function$;

-- Bulk reassign group
CREATE OR REPLACE FUNCTION public.admin_assign_group(_user_ids uuid[], _group_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  uid uuid := auth.uid();
  n integer;
BEGIN
  IF uid IS NULL OR NOT public.has_role(uid,'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.profiles SET group_id = _group_id WHERE id = ANY(_user_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.audit_log (actor_user_id, target_user_id, action, old_value, new_value)
    VALUES (uid, NULL, 'bulk_assign_group',
            jsonb_build_object('user_ids', to_jsonb(_user_ids)),
            jsonb_build_object('group_id', _group_id, 'count', n));
  RETURN n;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_assign_group(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_group(uuid[], uuid) TO authenticated;

-- Ungrouped students list
CREATE OR REPLACE FUNCTION public.admin_ungrouped_students()
RETURNS TABLE(id uuid, email text, name text, last_name text, telegram_username citext, telegram_id bigint, created_at timestamptz, last_sign_in_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
    SELECT p.id, p.email, p.name, p.last_name, p.telegram_username, p.telegram_id, p.created_at, u.last_sign_in_at
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE p.group_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin')
    ORDER BY p.created_at DESC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_ungrouped_students() TO authenticated;

-- Group health score
CREATE OR REPLACE FUNCTION public.group_health_score(_group_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  total int; active7 int; active_pct numeric := 0; avg_completion numeric := 0;
  avg_score numeric := 0; course_id uuid; total_lessons int := 0; result int;
BEGIN
  SELECT count(*) INTO total FROM public.profiles WHERE group_id = _group_id;
  IF total = 0 THEN RETURN 0; END IF;
  SELECT count(DISTINCT lp.user_id) INTO active7
    FROM public.lesson_progress lp JOIN public.profiles p ON p.id = lp.user_id
    WHERE p.group_id = _group_id AND lp.updated_at >= now() - interval '7 days';
  active_pct := (active7::numeric / total::numeric) * 100;
  SELECT g.course_id INTO course_id FROM public.groups g WHERE g.id = _group_id;
  IF course_id IS NOT NULL THEN
    SELECT count(*) INTO total_lessons FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      WHERE m.course_id = course_id AND l.published = true;
  END IF;
  IF total_lessons > 0 THEN
    SELECT COALESCE(avg(per_user_pct), 0) INTO avg_completion FROM (
      SELECT (count(*) FILTER (WHERE lp.completed_at IS NOT NULL)::numeric / total_lessons) * 100 AS per_user_pct
      FROM public.profiles p
      LEFT JOIN public.lesson_progress lp ON lp.user_id = p.id
      LEFT JOIN public.lessons l ON l.id = lp.lesson_id
      LEFT JOIN public.modules m ON m.id = l.module_id AND m.course_id = course_id
      WHERE p.group_id = _group_id GROUP BY p.id
    ) sub;
  END IF;
  SELECT COALESCE(avg(qa.score), 0) INTO avg_score FROM public.quiz_attempts qa
    JOIN public.profiles p ON p.id = qa.user_id WHERE p.group_id = _group_id;
  result := round(0.4 * LEAST(active_pct,100) + 0.4 * LEAST(avg_completion,100) + 0.2 * LEAST(avg_score,100))::int;
  RETURN GREATEST(0, LEAST(100, result));
END;
$function$;
GRANT EXECUTE ON FUNCTION public.group_health_score(uuid) TO authenticated;

-- Group overview
CREATE OR REPLACE FUNCTION public.staff_group_overview(_group_id uuid)
RETURNS TABLE(total int, active_7d int, completion_pct int, avg_score int, health int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  uid uuid := auth.uid();
  course_id uuid;
  total_lessons int := 0;
  c int;
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT count(*) INTO c FROM public.profiles WHERE group_id = _group_id;
  SELECT g.course_id INTO course_id FROM public.groups g WHERE g.id = _group_id;
  IF course_id IS NOT NULL THEN
    SELECT count(*) INTO total_lessons FROM public.lessons l
      JOIN public.modules m ON m.id = l.module_id
      WHERE m.course_id = course_id AND l.published = true;
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
        LEFT JOIN public.modules m ON m.id = l.module_id AND m.course_id = course_id
        WHERE p.group_id = _group_id GROUP BY p.id
      ) s) END AS completion_pct,
    (SELECT COALESCE(round(avg(qa.score))::int,0) FROM public.quiz_attempts qa
      JOIN public.profiles p ON p.id = qa.user_id WHERE p.group_id = _group_id) AS avg_score,
    public.group_health_score(_group_id) AS health;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.staff_group_overview(uuid) TO authenticated;

-- Group members
CREATE OR REPLACE FUNCTION public.staff_group_members(_group_id uuid)
RETURNS TABLE(id uuid, name text, last_name text, email text, telegram_username citext, telegram_id bigint, last_sign_in_at timestamptz, last_activity_at timestamptz, completed_lessons int, avg_score int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid();
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT p.id, p.name, p.last_name, p.email, p.telegram_username, p.telegram_id,
    u.last_sign_in_at,
    (SELECT max(lp.updated_at) FROM public.lesson_progress lp WHERE lp.user_id = p.id) AS last_activity_at,
    (SELECT count(*)::int FROM public.lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at IS NOT NULL) AS completed_lessons,
    (SELECT COALESCE(round(avg(qa.score))::int,0) FROM public.quiz_attempts qa WHERE qa.user_id = p.id) AS avg_score
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.group_id = _group_id
  ORDER BY p.created_at DESC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.staff_group_members(uuid) TO authenticated;

-- Per-module completion %
CREATE OR REPLACE FUNCTION public.staff_group_module_completion(_group_id uuid)
RETURNS TABLE(module_id uuid, title text, module_position int, completion_pct int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid(); course_id uuid; total_students int;
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT g.course_id INTO course_id FROM public.groups g WHERE g.id = _group_id;
  SELECT count(*) INTO total_students FROM public.profiles WHERE group_id = _group_id;
  IF course_id IS NULL OR total_students = 0 THEN RETURN; END IF;
  RETURN QUERY
  SELECT m.id, m.title, m.position,
    CASE WHEN lt.total = 0 THEN 0 ELSE round(
      (SELECT count(DISTINCT p.id)::numeric FROM public.profiles p
        WHERE p.group_id = _group_id
          AND (SELECT count(*) FROM public.lesson_progress lp
                JOIN public.lessons l ON l.id = lp.lesson_id
                WHERE lp.user_id = p.id AND l.module_id = m.id AND lp.completed_at IS NOT NULL) = lt.total
      ) / total_students::numeric * 100
    )::int END AS completion_pct
  FROM public.modules m
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS total FROM public.lessons l WHERE l.module_id = m.id AND l.published = true
  ) lt
  WHERE m.course_id = course_id
  ORDER BY m.position;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.staff_group_module_completion(uuid) TO authenticated;

-- Recent activity for the group
CREATE OR REPLACE FUNCTION public.staff_group_recent_activity(_group_id uuid, _lim int DEFAULT 20)
RETURNS TABLE(kind text, user_id uuid, name text, lesson_id uuid, lesson_title text, occurred_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid();
BEGIN
  IF NOT public.can_see_group(_group_id, uid) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT * FROM (
    (SELECT 'lesson_completed'::text AS kind, lp.user_id, p.name, lp.lesson_id, l.title AS lesson_title, lp.completed_at AS occurred_at
       FROM public.lesson_progress lp
       JOIN public.profiles p ON p.id = lp.user_id
       JOIN public.lessons l ON l.id = lp.lesson_id
       WHERE p.group_id = _group_id AND lp.completed_at IS NOT NULL
       ORDER BY lp.completed_at DESC LIMIT _lim)
    UNION ALL
    (SELECT 'login'::text, ae.user_id, p.name, NULL::uuid, NULL::text, ae.created_at
       FROM public.auth_events ae JOIN public.profiles p ON p.id = ae.user_id
       WHERE p.group_id = _group_id AND ae.event = 'login'
       ORDER BY ae.created_at DESC LIMIT _lim)
  ) u
  ORDER BY occurred_at DESC NULLS LAST
  LIMIT _lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.staff_group_recent_activity(uuid, int) TO authenticated;

-- Top students for the caller's groups (or any group for admin)
CREATE OR REPLACE FUNCTION public.staff_top_students(_lim int DEFAULT 10)
RETURNS TABLE(id uuid, name text, telegram_username citext, completed_lessons int, avg_score int, last_activity_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE uid uuid := auth.uid(); is_admin boolean := public.has_role(uid,'admin'::app_role);
BEGIN
  RETURN QUERY
  SELECT p.id, p.name, p.telegram_username,
    (SELECT count(*)::int FROM public.lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at IS NOT NULL) AS completed_lessons,
    (SELECT COALESCE(round(avg(qa.score))::int,0) FROM public.quiz_attempts qa WHERE qa.user_id = p.id) AS avg_score,
    (SELECT max(lp.updated_at) FROM public.lesson_progress lp WHERE lp.user_id = p.id) AS last_activity_at
  FROM public.profiles p
  WHERE
    CASE WHEN is_admin THEN true
         ELSE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)
    END
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin')
  ORDER BY completed_lessons DESC, avg_score DESC NULLS LAST
  LIMIT _lim;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.staff_top_students(int) TO authenticated;