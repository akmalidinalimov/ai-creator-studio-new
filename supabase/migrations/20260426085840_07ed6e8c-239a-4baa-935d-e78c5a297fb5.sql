
-- =========================================================================
-- ENUMS
-- =========================================================================
CREATE TYPE public.app_role AS ENUM ('admin', 'student');
CREATE TYPE public.user_status AS ENUM ('active', 'inactive');
CREATE TYPE public.chat_role AS ENUM ('user', 'assistant');

-- =========================================================================
-- UTILITY: updated_at trigger fn
-- =========================================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =========================================================================
-- PROFILES
-- =========================================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  timezone TEXT DEFAULT 'UTC',
  status public.user_status NOT NULL DEFAULT 'active',
  weekly_goal_lessons INT DEFAULT 5,
  goals TEXT,
  onboarding_completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================================
-- USER ROLES (separate table, never on profile)
-- =========================================================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- =========================================================================
-- COURSES / MODULES / LESSONS
-- =========================================================================
CREATE TABLE public.courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  cover_url TEXT,
  duration_hours NUMERIC,
  published BOOLEAN NOT NULL DEFAULT true,
  is_default_for_signup BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_modules_course ON public.modules(course_id, position);

CREATE TABLE public.lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT,
  video_storage_path TEXT,
  duration_seconds INT DEFAULT 0,
  position INT NOT NULL DEFAULT 0,
  transcript TEXT,
  resources JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_lessons_module ON public.lessons(module_id, position);

-- =========================================================================
-- ENROLLMENTS / PROGRESS / NOTES / BOOKMARKS / RATINGS / COMMENTS
-- =========================================================================
CREATE TABLE public.enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.lesson_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  seconds_watched INT DEFAULT 0,
  last_position_seconds INT DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);
ALTER TABLE public.lesson_progress ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_progress_updated BEFORE UPDATE ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.lesson_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  body TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);
ALTER TABLE public.lesson_notes ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_notes_updated BEFORE UPDATE ON public.lesson_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.lesson_bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  timestamp_seconds INT NOT NULL DEFAULT 0,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.lesson_bookmarks ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.lesson_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  stars INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);
ALTER TABLE public.lesson_ratings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.lesson_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.lesson_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.lesson_comments ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_comments_updated BEFORE UPDATE ON public.lesson_comments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================================
-- QUIZZES
-- =========================================================================
CREATE TABLE public.quiz_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  correct_index INT NOT NULL DEFAULT 0,
  explanation TEXT,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  score INT NOT NULL DEFAULT 0,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- AI CHAT
-- =========================================================================
CREATE TABLE public.ai_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES public.lessons(id) ON DELETE CASCADE,
  role public.chat_role NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_chat_user_lesson ON public.ai_chat_messages(user_id, lesson_id, created_at);

-- =========================================================================
-- STREAKS / EMAIL EVENTS / LAST ACTIVE
-- =========================================================================
CREATE TABLE public.streaks (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current_streak INT NOT NULL DEFAULT 0,
  longest_streak INT NOT NULL DEFAULT 0,
  last_active_date DATE
);
ALTER TABLE public.streaks ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at TIMESTAMPTZ
);
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- POLICIES
-- =========================================================================

-- profiles
CREATE POLICY "profiles select own or admin" ON public.profiles FOR SELECT
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles update own or admin" ON public.profiles FOR UPDATE
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles insert self" ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles delete admin" ON public.profiles FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- user_roles
CREATE POLICY "user_roles select own or admin" ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_roles admin manage" ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- courses (any authenticated reads published; admins all)
CREATE POLICY "courses read" ON public.courses FOR SELECT
  TO authenticated USING (published OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "courses admin write" ON public.courses FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- modules
CREATE POLICY "modules read" ON public.modules FOR SELECT TO authenticated USING (true);
CREATE POLICY "modules admin write" ON public.modules FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- lessons
CREATE POLICY "lessons read" ON public.lessons FOR SELECT TO authenticated USING (true);
CREATE POLICY "lessons admin write" ON public.lessons FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- enrollments
CREATE POLICY "enrollments select own or admin" ON public.enrollments FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "enrollments insert own or admin" ON public.enrollments FOR INSERT
  WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "enrollments delete own or admin" ON public.enrollments FOR DELETE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- lesson_progress
CREATE POLICY "progress select own or admin" ON public.lesson_progress FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "progress upsert own" ON public.lesson_progress FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "progress update own" ON public.lesson_progress FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "progress delete own or admin" ON public.lesson_progress FOR DELETE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- lesson_notes
CREATE POLICY "notes own all" ON public.lesson_notes FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

-- lesson_bookmarks
CREATE POLICY "bookmarks own all" ON public.lesson_bookmarks FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

-- lesson_ratings (everyone authenticated can read; only owner can write)
CREATE POLICY "ratings read" ON public.lesson_ratings FOR SELECT TO authenticated USING (true);
CREATE POLICY "ratings own write" ON public.lesson_ratings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ratings own update" ON public.lesson_ratings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ratings own delete" ON public.lesson_ratings FOR DELETE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- lesson_comments
CREATE POLICY "comments read" ON public.lesson_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "comments insert own" ON public.lesson_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "comments update own" ON public.lesson_comments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "comments delete own or admin" ON public.lesson_comments FOR DELETE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- quiz_questions
CREATE POLICY "quiz_q read" ON public.quiz_questions FOR SELECT TO authenticated USING (true);
CREATE POLICY "quiz_q admin write" ON public.quiz_questions FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- quiz_attempts
CREATE POLICY "quiz_a own all" ON public.quiz_attempts FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

-- ai_chat_messages
CREATE POLICY "chat own all" ON public.ai_chat_messages FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

-- streaks
CREATE POLICY "streaks own select" ON public.streaks FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "streaks own write" ON public.streaks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "streaks own update" ON public.streaks FOR UPDATE USING (auth.uid() = user_id);

-- email_events (admin only)
CREATE POLICY "email_events admin all" ON public.email_events FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- =========================================================================
-- AUTO-CREATE PROFILE / ROLE / ENROLLMENT ON SIGNUP
-- =========================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_course UUID;
BEGIN
  INSERT INTO public.profiles (id, email, name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
    NEW.raw_user_meta_data->>'avatar_url'
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'student')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.streaks (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;

  SELECT id INTO default_course FROM public.courses WHERE is_default_for_signup LIMIT 1;
  IF default_course IS NOT NULL THEN
    INSERT INTO public.enrollments (user_id, course_id)
    VALUES (NEW.id, default_course)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================================================
-- STORAGE BUCKETS
-- =========================================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('lesson-videos', 'lesson-videos', false),
  ('lesson-resources', 'lesson-resources', false),
  ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- lesson-videos: authenticated read; admin write
CREATE POLICY "lesson-videos read auth" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'lesson-videos');
CREATE POLICY "lesson-videos admin write" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'lesson-videos' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-videos admin update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'lesson-videos' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-videos admin delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'lesson-videos' AND public.has_role(auth.uid(), 'admin'));

-- lesson-resources: same pattern
CREATE POLICY "lesson-resources read auth" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'lesson-resources');
CREATE POLICY "lesson-resources admin write" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'lesson-resources' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-resources admin update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'lesson-resources' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "lesson-resources admin delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'lesson-resources' AND public.has_role(auth.uid(), 'admin'));

-- avatars: public read; users write to their own folder
CREATE POLICY "avatars read public" ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');
CREATE POLICY "avatars write own" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "avatars update own" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "avatars delete own" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
