-- handle_new_user ignored raw_user_meta_data->>'last_name', and the signup
-- page's follow-up PATCH runs unauthenticated when email confirmation is on,
-- so last names were silently dropped for confirmed-email signups.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_course UUID;
BEGIN
  INSERT INTO public.profiles (id, email, name, last_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
    NULLIF(NEW.raw_user_meta_data->>'last_name', ''),
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
