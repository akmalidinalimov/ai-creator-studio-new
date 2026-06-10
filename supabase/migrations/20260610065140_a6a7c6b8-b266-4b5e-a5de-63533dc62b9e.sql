-- 1. Seed the four new streak milestone badges (mirrors the existing streak_7 / streak_30 rows).

INSERT INTO public.badges (code, name_uz, name_ru, name_en, description_uz, description_ru, description_en, icon, position) VALUES
  ('streak_3',  '🔥 3 kun qatorasiga',   '🔥 3 дня подряд',    '🔥 3-day streak',   '3 kun ketma-ket o''rgandingiz',   'Учились 3 дня подряд',    'Studied 3 days in a row',    '🔥',   9),
  ('streak_14', '🔥 14 kun qatorasiga',  '🔥 14 дней подряд',  '🔥 14-day streak',  '14 kun ketma-ket o''rgandingiz',  'Учились 14 дней подряд',  'Studied 14 days in a row',   '🔥',  10),
  ('streak_60', '🔥🔥 60 kun qatorasiga','🔥🔥 60 дней подряд','🔥🔥 60-day streak','60 kun ketma-ket o''rgandingiz',  'Учились 60 дней подряд',  'Studied 60 days in a row',   '🔥🔥',11),
  ('streak_100','👑 100 kun qatorasiga', '👑 100 дней подряд', '👑 100-day streak', '100 kun ketma-ket o''rgandingiz', 'Учились 100 дней подряд', 'Studied 100 days in a row',  '👑',  12)
ON CONFLICT (code) DO NOTHING;


-- 2. Extend evaluate_streak_badges to award all milestones (keeps the existing 7 and 30).

CREATE OR REPLACE FUNCTION public.evaluate_streak_badges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_streak >= 3   THEN PERFORM award_badge(NEW.user_id, 'streak_3');   END IF;
  IF NEW.current_streak >= 7   THEN PERFORM award_badge(NEW.user_id, 'streak_7');   END IF;
  IF NEW.current_streak >= 14  THEN PERFORM award_badge(NEW.user_id, 'streak_14');  END IF;
  IF NEW.current_streak >= 30  THEN PERFORM award_badge(NEW.user_id, 'streak_30');  END IF;
  IF NEW.current_streak >= 60  THEN PERFORM award_badge(NEW.user_id, 'streak_60');  END IF;
  IF NEW.current_streak >= 100 THEN PERFORM award_badge(NEW.user_id, 'streak_100'); END IF;
  RETURN NEW;
END;
$$;


-- 3. SILENT backfill: grant the new badges to students who already qualify, WITHOUT sending DMs.
--    Disable the DM-queue trigger only for this backfill insert, then re-enable it. Going forward,
--    new milestone crossings will DM normally.

ALTER TABLE public.user_badges DISABLE TRIGGER trg_queue_badge_dm;

INSERT INTO public.user_badges (user_id, badge_id)
SELECT s.user_id, b.id
FROM public.streaks s
JOIN public.badges b ON (
       (b.code = 'streak_3'   AND s.current_streak >= 3)
    OR (b.code = 'streak_14'  AND s.current_streak >= 14)
    OR (b.code = 'streak_60'  AND s.current_streak >= 60)
    OR (b.code = 'streak_100' AND s.current_streak >= 100)
)
ON CONFLICT (user_id, badge_id) DO NOTHING;

ALTER TABLE public.user_badges ENABLE TRIGGER trg_queue_badge_dm;