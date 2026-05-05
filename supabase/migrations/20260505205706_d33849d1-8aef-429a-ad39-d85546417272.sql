
-- Per-group login stats (admins + teachers can read; teacher only sees own groups via filter in app)
CREATE OR REPLACE FUNCTION public.admin_group_login_stats()
RETURNS TABLE(group_id uuid, total_active integer, logged_in_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'teacher'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT p.group_id,
         COUNT(*)::int AS total_active,
         COUNT(u.last_sign_in_at)::int AS logged_in_count
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.group_id IS NOT NULL
    AND p.status = 'active'
    AND p.archived_at IS NULL
  GROUP BY p.group_id;
END;
$$;

-- Per-group export with login fields
CREATE OR REPLACE FUNCTION public.admin_export_group_csv(_group_id uuid, _include_archived boolean DEFAULT false)
RETURNS TABLE(
  id uuid,
  name text,
  last_name text,
  email text,
  telegram_user_id bigint,
  telegram_username citext,
  role text,
  group_name text,
  first_login_at timestamptz,
  last_login_at timestamptz,
  has_logged_in boolean,
  lessons_completed integer,
  homework_avg numeric,
  status user_status,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(),'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = _group_id AND g.teacher_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.last_name,
    p.email,
    p.telegram_id AS telegram_user_id,
    p.telegram_username,
    COALESCE(
      (SELECT ur.role::text FROM public.user_roles ur
        WHERE ur.user_id = p.id
        ORDER BY CASE ur.role WHEN 'admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END
        LIMIT 1),
      'student'
    ) AS role,
    g.name AS group_name,
    (SELECT MIN(ae.created_at) FROM public.auth_events ae WHERE ae.user_id = p.id AND ae.event = 'sign_in') AS first_login_at,
    u.last_sign_in_at AS last_login_at,
    (u.last_sign_in_at IS NOT NULL) AS has_logged_in,
    COALESCE((SELECT COUNT(*)::int FROM public.lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at IS NOT NULL), 0) AS lessons_completed,
    (SELECT ROUND(AVG(hs.score)::numeric, 2) FROM public.homework_submissions hs WHERE hs.user_id = p.id AND hs.score IS NOT NULL) AS homework_avg,
    p.status,
    p.created_at
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  LEFT JOIN public.groups g ON g.id = p.group_id
  WHERE p.group_id = _group_id
    AND (_include_archived OR (p.status = 'active' AND p.archived_at IS NULL));
END;
$$;
