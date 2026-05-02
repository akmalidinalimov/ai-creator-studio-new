
-- assignments
CREATE TABLE IF NOT EXISTS public.homework_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL UNIQUE REFERENCES public.modules(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  prompt_uz text,
  prompt_ru text,
  prompt_en text,
  max_score smallint NOT NULL DEFAULT 10 CHECK (max_score BETWEEN 1 AND 10),
  due_days_after_module_unlock int NOT NULL DEFAULT 7,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hwa read auth" ON public.homework_assignments FOR SELECT TO authenticated USING (true);
CREATE POLICY "hwa admin write" ON public.homework_assignments FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'teacher'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'teacher'::app_role));

-- submissions
CREATE TABLE IF NOT EXISTS public.homework_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  submitted_text text NOT NULL DEFAULT '',
  submitted_image_url text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  score smallint,
  score_feedback text,
  scored_by uuid,
  scored_at timestamptz,
  is_late boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, user_id)
);
ALTER TABLE public.homework_submissions ENABLE ROW LEVEL SECURITY;

-- score range trigger (must be <= assignment.max_score)
CREATE OR REPLACE FUNCTION public.validate_hw_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE m smallint;
BEGIN
  IF NEW.score IS NOT NULL THEN
    SELECT max_score INTO m FROM homework_assignments WHERE id = NEW.assignment_id;
    IF NEW.score < 0 OR NEW.score > COALESCE(m, 10) THEN
      RAISE EXCEPTION 'score must be between 0 and %', COALESCE(m, 10);
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at = now(); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_hw_submission ON public.homework_submissions;
CREATE TRIGGER trg_validate_hw_submission
  BEFORE INSERT OR UPDATE ON public.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION public.validate_hw_submission();

-- award first_homework badge on submission
CREATE OR REPLACE FUNCTION public.award_first_homework()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM award_badge(NEW.user_id, 'first_homework');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_award_first_homework ON public.homework_submissions;
CREATE TRIGGER trg_award_first_homework
  AFTER INSERT ON public.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION public.award_first_homework();

-- RLS: students manage own; teachers/admin read all (and update score)
CREATE POLICY "hws own select" ON public.homework_submissions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'teacher'::app_role));
CREATE POLICY "hws own insert" ON public.homework_submissions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "hws own update" ON public.homework_submissions FOR UPDATE TO authenticated
  USING (
    (auth.uid() = user_id AND score IS NULL)
    OR has_role(auth.uid(),'admin'::app_role)
    OR has_role(auth.uid(),'teacher'::app_role)
  );
CREATE POLICY "hws admin delete" ON public.homework_submissions FOR DELETE TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role));

-- storage bucket (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('homework_images','homework_images', false, 5242880, ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=5242880,
  allowed_mime_types=ARRAY['image/png','image/jpeg','image/webp'];

-- storage RLS
DROP POLICY IF EXISTS "hwimg user upload own" ON storage.objects;
CREATE POLICY "hwimg user upload own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='homework_images' AND auth.uid()::text = (storage.foldername(name))[1]);
DROP POLICY IF EXISTS "hwimg user read own" ON storage.objects;
CREATE POLICY "hwimg user read own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='homework_images' AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR has_role(auth.uid(),'admin'::app_role)
    OR has_role(auth.uid(),'teacher'::app_role)
  ));
DROP POLICY IF EXISTS "hwimg user update own" ON storage.objects;
CREATE POLICY "hwimg user update own" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id='homework_images' AND auth.uid()::text = (storage.foldername(name))[1]);
DROP POLICY IF EXISTS "hwimg user delete own" ON storage.objects;
CREATE POLICY "hwimg user delete own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id='homework_images' AND (
    auth.uid()::text = (storage.foldername(name))[1] OR has_role(auth.uid(),'admin'::app_role)
  ));

-- pending grading count for teacher (their group) or admin (all)
CREATE OR REPLACE FUNCTION public.homework_pending_count_for_user(_uid uuid)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int;
BEGIN
  IF has_role(_uid,'admin'::app_role) THEN
    SELECT COUNT(*) INTO n FROM homework_submissions WHERE score IS NULL;
  ELSIF has_role(_uid,'teacher'::app_role) THEN
    SELECT COUNT(*) INTO n
      FROM homework_submissions s
      JOIN profiles p ON p.id = s.user_id
      JOIN groups g ON g.id = p.group_id
     WHERE s.score IS NULL AND g.teacher_id = _uid;
  ELSE n := 0;
  END IF;
  RETURN COALESCE(n, 0);
END;
$$;

-- updated leaderboard recalc with homework component
CREATE OR REPLACE FUNCTION public.recalc_leaderboard()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_lessons int;
  max_minutes int;
BEGIN
  CREATE TEMP TABLE tmp_lb ON COMMIT DROP AS
  SELECT
    p.id AS user_id,
    COALESCE((SELECT COUNT(*)::int FROM lesson_progress lp
              WHERE lp.user_id = p.id
                AND lp.completed_at >= now() - interval '30 days'), 0) AS lessons_30d,
    COALESCE((SELECT (SUM(total_seconds)/60)::int FROM daily_watch_summary d
              WHERE d.user_id = p.id
                AND d.watch_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 30), 0) AS minutes_30d,
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak,
    COALESCE((SELECT AVG(score)::numeric FROM homework_submissions hs
              WHERE hs.user_id = p.id
                AND hs.score IS NOT NULL
                AND hs.scored_at >= now() - interval '30 days'), NULL) AS avg_hw
  FROM profiles p
  WHERE NOT has_role(p.id, 'admin'::app_role)
    AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(lessons_30d), 1), GREATEST(MAX(minutes_30d), 1)
    INTO max_lessons, max_minutes FROM tmp_lb;

  DELETE FROM leaderboard_cache;
  INSERT INTO leaderboard_cache (user_id, score, lessons_30d, minutes_30d, current_streak, rank, computed_at)
  SELECT
    user_id,
    LEAST(100, GREATEST(0, ROUND(
      CASE WHEN avg_hw IS NULL THEN
        -- normalize without homework: weights become 4/7, 2/7, 1/7
        ((0.4 * (lessons_30d::numeric / max_lessons))
         + (0.2 * (LEAST(current_streak, 30)::numeric / 30))
         + (0.1 * (minutes_30d::numeric / max_minutes))) / 0.7 * 100
      ELSE
        ((0.4 * (lessons_30d::numeric / max_lessons))
         + (0.3 * (avg_hw / 10))
         + (0.2 * (LEAST(current_streak, 30)::numeric / 30))
         + (0.1 * (minutes_30d::numeric / max_minutes))) * 100
      END
    )::int)) AS score,
    lessons_30d, minutes_30d, current_streak, NULL::int, now()
  FROM tmp_lb;

  WITH ranked AS (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY score DESC, lessons_30d DESC, current_streak DESC) AS r
    FROM leaderboard_cache
  )
  UPDATE leaderboard_cache lc SET rank = ranked.r FROM ranked WHERE ranked.user_id = lc.user_id;
END;
$$;
