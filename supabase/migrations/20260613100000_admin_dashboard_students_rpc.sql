-- Admin/teacher dashboard KPI source. The dashboard previously fetched raw
-- auth_events / lesson_progress rows client-side with .limit(50000) to count them,
-- but PostgREST caps responses at 1000 rows (no override in config.toml), so
-- active7d/active30d/logins were computed on truncated data (e.g. active7d showed
-- 96 vs the true ~224). This returns ONE row per in-scope student (<= total students,
-- well under the cap) with activity aggregated server-side. It also excludes staff
-- (admin/superadmin/teacher) so they no longer leak into the inactive/never lists.
CREATE OR REPLACE FUNCTION public.admin_dashboard_students(_course_id uuid, _since30 timestamptz)
RETURNS TABLE(
  id uuid,
  name text,
  last_name text,
  telegram_username citext,
  telegram_id bigint,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  last_auth_at timestamptz,
  last_lesson_at timestamptz,
  logins_30d int,
  course_completed boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  is_admin boolean;
  is_teacher boolean;
  total_lessons int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;
  is_admin := public.has_role(uid, 'admin'::app_role) OR public.has_role(uid, 'superadmin'::app_role);
  is_teacher := public.has_role(uid, 'teacher'::app_role);
  IF NOT (is_admin OR is_teacher) THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT count(*) INTO total_lessons
  FROM public.lessons l
  JOIN public.modules m ON m.id = l.module_id
  WHERE m.course_id = _course_id AND l.published;

  RETURN QUERY
  SELECT
    p.id, p.name, p.last_name, p.telegram_username, p.telegram_id, p.email, p.created_at,
    u.last_sign_in_at,
    (SELECT max(ae.created_at) FROM public.auth_events ae
       WHERE ae.user_id = p.id AND ae.created_at >= _since30),
    (SELECT max(lp.updated_at) FROM public.lesson_progress lp
       WHERE lp.user_id = p.id AND lp.updated_at >= _since30),
    (SELECT count(*)::int FROM public.auth_events ae
       WHERE ae.user_id = p.id AND ae.created_at >= _since30 AND ae.event IN ('sign_in','login')),
    (total_lessons > 0 AND (
       SELECT count(DISTINCT lp.lesson_id) FROM public.lesson_progress lp
       JOIN public.lessons l ON l.id = lp.lesson_id
       JOIN public.modules m ON m.id = l.module_id
       WHERE lp.user_id = p.id AND m.course_id = _course_id AND l.published AND lp.completed_at IS NOT NULL
     ) >= total_lessons)
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.status = 'active'
    AND p.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id
        AND ur.role IN ('admin'::app_role, 'superadmin'::app_role, 'teacher'::app_role)
    )
    AND (
      is_admin
      OR (is_teacher AND p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))
    )
  ORDER BY p.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_students(uuid, timestamptz) TO authenticated;
