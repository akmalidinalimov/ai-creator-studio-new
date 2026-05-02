
-- profiles.digest_opt_in
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS digest_opt_in boolean NOT NULL DEFAULT true;

-- user_daily_goal
CREATE TABLE IF NOT EXISTS public.user_daily_goal (
  user_id uuid PRIMARY KEY,
  target int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_daily_goal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "udg own all" ON public.user_daily_goal
  FOR ALL TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (auth.uid() = user_id);

-- badges catalog
CREATE TABLE IF NOT EXISTS public.badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name_uz text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  description_uz text,
  description_ru text,
  description_en text,
  icon text,
  position int NOT NULL DEFAULT 0,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "badges read all" ON public.badges FOR SELECT TO authenticated USING (true);
CREATE POLICY "badges admin write" ON public.badges FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- user_badges
CREATE TABLE IF NOT EXISTS public.user_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  badge_id uuid NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  earned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_id)
);
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_badges select own or admin" ON public.user_badges FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "user_badges admin write" ON public.user_badges FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Seed 8 badges
INSERT INTO public.badges (code, name_uz, name_ru, name_en, description_uz, description_ru, description_en, icon, position) VALUES
  ('first_lesson','🎬 Birinchi qadam','🎬 Первый шаг','🎬 First step','Birinchi darsni tomosha qildingiz','Просмотрели первый урок','Watched your first lesson','🎬',1),
  ('five_lessons','🚀 5 ta dars','🚀 5 уроков','🚀 5 lessons','5 ta darsni tugatdingiz','Завершили 5 уроков','Completed 5 lessons','🚀',2),
  ('ten_lessons','⭐ 10 ta dars','⭐ 10 уроков','⭐ 10 lessons','10 ta darsni tugatdingiz','Завершили 10 уроков','Completed 10 lessons','⭐',3),
  ('module_complete','📚 Modul tugatildi','📚 Модуль завершён','📚 Module complete','Birorta modulni tugatdingiz','Завершили модуль','Completed a module','📚',4),
  ('course_complete','🏆 Kurs tugatildi','🏆 Курс завершён','🏆 Course complete','Butun kursni tugatdingiz','Завершили весь курс','Completed the entire course','🏆',5),
  ('streak_7','🔥 7 kun qatorasiga','🔥 7 дней подряд','🔥 7-day streak','7 kun ketma-ket o''rgandingiz','Учились 7 дней подряд','Studied 7 days in a row','🔥',6),
  ('streak_30','🔥🔥 30 kun qatorasiga','🔥🔥 30 дней подряд','🔥🔥 30-day streak','30 kun ketma-ket o''rgandingiz','Учились 30 дней подряд','Studied 30 days in a row','🔥🔥',7),
  ('first_homework','📝 Birinchi uy vazifasi','📝 Первое задание','📝 First homework','Birinchi uy vazifasini topshirdingiz','Сдали первое домашнее задание','Submitted your first homework','📝',8)
ON CONFLICT (code) DO NOTHING;

-- leaderboard cache
CREATE TABLE IF NOT EXISTS public.leaderboard_cache (
  user_id uuid PRIMARY KEY,
  score int NOT NULL DEFAULT 0,
  lessons_30d int NOT NULL DEFAULT 0,
  minutes_30d int NOT NULL DEFAULT 0,
  current_streak int NOT NULL DEFAULT 0,
  rank int,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.leaderboard_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leaderboard read auth" ON public.leaderboard_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "leaderboard admin write" ON public.leaderboard_cache FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- daily goal progress
CREATE OR REPLACE FUNCTION public.daily_goal_progress(uid uuid)
RETURNS TABLE(target int, done int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT g.target FROM user_daily_goal g WHERE g.user_id = uid), 1),
    COALESCE((
      SELECT COUNT(DISTINCT lp.lesson_id)::int
      FROM lesson_progress lp
      WHERE lp.user_id = uid
        AND (
          (lp.completed_at IS NOT NULL AND lp.completed_at::date = (now() AT TIME ZONE 'Asia/Tashkent')::date)
          OR (lp.updated_at::date = (now() AT TIME ZONE 'Asia/Tashkent')::date AND COALESCE(lp.watch_seconds_total,0) >= 30)
        )
    ), 0);
$$;

-- award helper
CREATE OR REPLACE FUNCTION public.award_badge(uid uuid, _code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE bid uuid;
BEGIN
  SELECT id INTO bid FROM badges WHERE code = _code;
  IF bid IS NULL THEN RETURN; END IF;
  INSERT INTO user_badges (user_id, badge_id) VALUES (uid, bid)
    ON CONFLICT (user_id, badge_id) DO NOTHING;
END;
$$;

-- award lesson-count + module/course badges on progress completion
CREATE OR REPLACE FUNCTION public.evaluate_lesson_badges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  watched_count int;
  completed_count int;
  mod_id uuid;
  mod_total int;
  mod_done int;
  course_id_v uuid;
  course_total int;
  course_done int;
BEGIN
  -- first_lesson: any progress with watch >=30 OR completed
  SELECT COUNT(*) INTO watched_count FROM lesson_progress
    WHERE user_id = NEW.user_id
      AND (completed_at IS NOT NULL OR COALESCE(watch_seconds_total,0) >= 30);
  IF watched_count >= 1 THEN PERFORM award_badge(NEW.user_id, 'first_lesson'); END IF;

  -- 5/10 lessons completed
  SELECT COUNT(*) INTO completed_count FROM lesson_progress
    WHERE user_id = NEW.user_id AND completed_at IS NOT NULL;
  IF completed_count >= 5 THEN PERFORM award_badge(NEW.user_id, 'five_lessons'); END IF;
  IF completed_count >= 10 THEN PERFORM award_badge(NEW.user_id, 'ten_lessons'); END IF;

  -- module completion (only if this update marked completion)
  IF NEW.completed_at IS NOT NULL THEN
    SELECT module_id INTO mod_id FROM lessons WHERE id = NEW.lesson_id;
    IF mod_id IS NOT NULL THEN
      SELECT COUNT(*) INTO mod_total FROM lessons WHERE module_id = mod_id AND published = true;
      SELECT COUNT(*) INTO mod_done FROM lesson_progress lp
        JOIN lessons l ON l.id = lp.lesson_id
        WHERE l.module_id = mod_id AND lp.user_id = NEW.user_id AND lp.completed_at IS NOT NULL;
      IF mod_total > 0 AND mod_done >= mod_total THEN
        PERFORM award_badge(NEW.user_id, 'module_complete');
        SELECT course_id INTO course_id_v FROM modules WHERE id = mod_id;
        IF course_id_v IS NOT NULL THEN
          SELECT COUNT(*) INTO course_total FROM lessons l JOIN modules m ON m.id=l.module_id
            WHERE m.course_id = course_id_v AND l.published = true;
          SELECT COUNT(*) INTO course_done FROM lesson_progress lp
            JOIN lessons l ON l.id = lp.lesson_id
            JOIN modules m ON m.id = l.module_id
            WHERE m.course_id = course_id_v AND lp.user_id = NEW.user_id AND lp.completed_at IS NOT NULL;
          IF course_total > 0 AND course_done >= course_total THEN
            PERFORM award_badge(NEW.user_id, 'course_complete');
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluate_lesson_badges ON public.lesson_progress;
CREATE TRIGGER trg_evaluate_lesson_badges
  AFTER INSERT OR UPDATE ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.evaluate_lesson_badges();

-- streak badges
CREATE OR REPLACE FUNCTION public.evaluate_streak_badges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_streak >= 7 THEN PERFORM award_badge(NEW.user_id, 'streak_7'); END IF;
  IF NEW.current_streak >= 30 THEN PERFORM award_badge(NEW.user_id, 'streak_30'); END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluate_streak_badges ON public.streaks;
CREATE TRIGGER trg_evaluate_streak_badges
  AFTER INSERT OR UPDATE ON public.streaks
  FOR EACH ROW EXECUTE FUNCTION public.evaluate_streak_badges();

-- streak rollover (zero out broken streaks)
CREATE OR REPLACE FUNCTION public.zero_broken_streaks()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE streaks
    SET current_streak = 0
    WHERE current_streak > 0
      AND last_active_date < ((now() AT TIME ZONE 'Asia/Tashkent')::date - 1);
$$;

-- recalc leaderboard
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
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak
  FROM profiles p
  WHERE NOT has_role(p.id, 'admin'::app_role)
    AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(lessons_30d), 1), GREATEST(MAX(minutes_30d), 1) INTO max_lessons, max_minutes FROM tmp_lb;

  DELETE FROM leaderboard_cache;
  INSERT INTO leaderboard_cache (user_id, score, lessons_30d, minutes_30d, current_streak, rank, computed_at)
  SELECT
    user_id,
    LEAST(100, GREATEST(0, ROUND(
      0.4 * (lessons_30d::numeric / max_lessons) * 100
      + 0.2 * (LEAST(current_streak, 30)::numeric / 30) * 100
      + 0.1 * (minutes_30d::numeric / max_minutes) * 100
      + 0.3 * 0   -- homework score placeholder (v3.0.5)
    )::int)) AS score,
    lessons_30d, minutes_30d, current_streak,
    NULL::int,
    now()
  FROM tmp_lb;

  WITH ranked AS (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY score DESC, lessons_30d DESC, current_streak DESC) AS r
    FROM leaderboard_cache
  )
  UPDATE leaderboard_cache lc SET rank = ranked.r FROM ranked WHERE ranked.user_id = lc.user_id;
END;
$$;

-- top leaderboard fetch
CREATE OR REPLACE FUNCTION public.leaderboard_top(_limit int DEFAULT 10)
RETURNS TABLE(rank int, user_id uuid, first_name text, last_initial text, score int, current_streak int, lessons_30d int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    lc.rank,
    lc.user_id,
    COALESCE(NULLIF(p.name,''), 'Talaba') AS first_name,
    COALESCE(LEFT(NULLIF(p.last_name,''),1), '') AS last_initial,
    lc.score, lc.current_streak, lc.lessons_30d
  FROM leaderboard_cache lc
  LEFT JOIN profiles p ON p.id = lc.user_id
  WHERE lc.rank IS NOT NULL
  ORDER BY lc.rank
  LIMIT _limit;
$$;

CREATE OR REPLACE FUNCTION public.leaderboard_my_rank(uid uuid)
RETURNS TABLE(rank int, total int, score int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT rank FROM leaderboard_cache WHERE user_id = uid),
    (SELECT COUNT(*)::int FROM leaderboard_cache),
    (SELECT score FROM leaderboard_cache WHERE user_id = uid);
$$;
