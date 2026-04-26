
-- =========================================================================
-- LESSONS / COURSES schema additions
-- =========================================================================
ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS video_provider TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS provider_video_id TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_path TEXT;

ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_video_provider_check
  CHECK (video_provider IN ('upload','youtube','vimeo','mux','bunny'));

-- Backfill: keep existing seed lessons visible
UPDATE public.lessons SET published = true WHERE published = false;

-- New courses default to draft from now on
ALTER TABLE public.courses ALTER COLUMN published SET DEFAULT false;

-- =========================================================================
-- citext + Telegram fields on profiles
-- =========================================================================
CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_username CITEXT,
  ADD COLUMN IF NOT EXISTS telegram_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_telegram_username_unique'
  ) THEN
    CREATE UNIQUE INDEX profiles_telegram_username_unique
      ON public.profiles (telegram_username) WHERE telegram_username IS NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_telegram_id_unique'
  ) THEN
    CREATE UNIQUE INDEX profiles_telegram_id_unique
      ON public.profiles (telegram_id) WHERE telegram_id IS NOT NULL;
  END IF;
END $$;

-- =========================================================================
-- AUTH EVENTS audit
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_auth_events_user_created ON public.auth_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_created ON public.auth_events(created_at DESC);

CREATE POLICY "auth_events insert own"
  ON public.auth_events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "auth_events select own or admin"
  ON public.auth_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- =========================================================================
-- PLATFORM SETTINGS (admin only)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Public read for non-secret keys (the Telegram bot username is public)
CREATE POLICY "platform_settings public read"
  ON public.platform_settings FOR SELECT
  USING (true);

CREATE POLICY "platform_settings admin write"
  ON public.platform_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "platform_settings admin update"
  ON public.platform_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "platform_settings admin delete"
  ON public.platform_settings FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- =========================================================================
-- STORAGE BUCKETS
-- =========================================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('course-covers', 'course-covers', true),
  ('lesson-thumbs', 'lesson-thumbs', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "course-covers public read"
  ON storage.objects FOR SELECT USING (bucket_id = 'course-covers');
CREATE POLICY "course-covers admin write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'course-covers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "course-covers admin update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'course-covers' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "course-covers admin delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'course-covers' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "lesson-thumbs public read"
  ON storage.objects FOR SELECT USING (bucket_id = 'lesson-thumbs');
CREATE POLICY "lesson-thumbs admin write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'lesson-thumbs' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-thumbs admin update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'lesson-thumbs' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-thumbs admin delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'lesson-thumbs' AND public.has_role(auth.uid(), 'admin'));

-- =========================================================================
-- INDEXES for scale
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_lesson_progress_user_lesson ON public.lesson_progress(user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_user_completed ON public.lesson_progress(user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_user_updated ON public.lesson_progress(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_user ON public.enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON public.enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_lessons_module_pos ON public.lessons(module_id, position);
CREATE INDEX IF NOT EXISTS idx_modules_course_pos ON public.modules(course_id, position);
CREATE INDEX IF NOT EXISTS idx_lessons_published ON public.lessons(published) WHERE published = true;

-- =========================================================================
-- RLS update: lessons — students see only published lessons
-- =========================================================================
DROP POLICY IF EXISTS "lessons read" ON public.lessons;
CREATE POLICY "lessons read"
  ON public.lessons FOR SELECT TO authenticated
  USING (published = true OR public.has_role(auth.uid(), 'admin'));

-- =========================================================================
-- STREAKS trigger
-- =========================================================================
CREATE OR REPLACE FUNCTION public.update_streak_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today_d DATE := (now() AT TIME ZONE 'UTC')::date;
  last_d DATE;
  cur INT;
  longest INT;
BEGIN
  SELECT last_active_date, current_streak, longest_streak
    INTO last_d, cur, longest
    FROM public.streaks WHERE user_id = NEW.user_id;

  IF last_d IS NULL THEN
    INSERT INTO public.streaks (user_id, current_streak, longest_streak, last_active_date)
      VALUES (NEW.user_id, 1, 1, today_d)
      ON CONFLICT (user_id) DO UPDATE
        SET current_streak = 1, longest_streak = GREATEST(public.streaks.longest_streak, 1), last_active_date = today_d;
    RETURN NEW;
  END IF;

  IF last_d = today_d THEN
    -- same day, no change
    RETURN NEW;
  ELSIF last_d = today_d - INTERVAL '1 day' THEN
    cur := cur + 1;
  ELSE
    cur := 1;
  END IF;

  longest := GREATEST(COALESCE(longest, 0), cur);
  UPDATE public.streaks
    SET current_streak = cur, longest_streak = longest, last_active_date = today_d
    WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lesson_progress_streak ON public.lesson_progress;
CREATE TRIGGER trg_lesson_progress_streak
  AFTER INSERT OR UPDATE ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_streak_for_user();

-- =========================================================================
-- Admin RPC: list users with last_sign_in_at and role
-- =========================================================================
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  status public.user_status,
  telegram_username CITEXT,
  telegram_id BIGINT,
  created_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  is_admin BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT p.id, p.email, p.name, p.avatar_url, p.status, p.telegram_username, p.telegram_id,
         p.created_at, u.last_sign_in_at,
         EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin') AS is_admin
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  ORDER BY p.created_at DESC;
END;
$$;

-- Per-course progress percent (admin only)
CREATE OR REPLACE FUNCTION public.admin_course_progress(_course_id UUID)
RETURNS TABLE (user_id UUID, completed_count INT, total_count INT, pct INT, last_activity TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total INT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT count(*) INTO total
    FROM public.lessons l
    JOIN public.modules m ON m.id = l.module_id
    WHERE m.course_id = _course_id AND l.published = true;

  IF total = 0 THEN total := 1; END IF;

  RETURN QUERY
  SELECT e.user_id,
         COALESCE(p.cnt, 0)::INT AS completed_count,
         total AS total_count,
         (COALESCE(p.cnt, 0) * 100 / total)::INT AS pct,
         p.last_activity
  FROM public.enrollments e
  LEFT JOIN (
    SELECT lp.user_id, count(*) FILTER (WHERE lp.completed_at IS NOT NULL) AS cnt,
           max(lp.updated_at) AS last_activity
    FROM public.lesson_progress lp
    JOIN public.lessons l ON l.id = lp.lesson_id
    JOIN public.modules m ON m.id = l.module_id
    WHERE m.course_id = _course_id
    GROUP BY lp.user_id
  ) p ON p.user_id = e.user_id
  WHERE e.course_id = _course_id;
END;
$$;
