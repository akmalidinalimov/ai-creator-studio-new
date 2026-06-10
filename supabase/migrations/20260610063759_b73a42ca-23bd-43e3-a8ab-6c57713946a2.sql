ALTER TABLE public.streaks ADD COLUMN IF NOT EXISTS freezes_remaining int NOT NULL DEFAULT 2;

CREATE OR REPLACE FUNCTION public.zero_broken_streaks()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff date := (now() AT TIME ZONE 'Asia/Tashkent')::date - 1;
BEGIN
  UPDATE streaks
    SET freezes_remaining = freezes_remaining - 1,
        last_active_date = cutoff
    WHERE current_streak > 0
      AND last_active_date < cutoff
      AND freezes_remaining > 0;
  UPDATE streaks
    SET current_streak = 0
    WHERE current_streak > 0
      AND last_active_date < cutoff
      AND freezes_remaining <= 0;
END;
$$;

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
    RETURN NEW;
  ELSIF last_d = today_d - INTERVAL '1 day' THEN
    cur := cur + 1;
  ELSE
    cur := 1;
  END IF;

  longest := GREATEST(COALESCE(longest, 0), cur);
  UPDATE public.streaks
    SET current_streak = cur,
        longest_streak = longest,
        last_active_date = today_d,
        freezes_remaining = CASE WHEN cur > 0 AND cur % 7 = 0
                                 THEN LEAST(2, freezes_remaining + 1)
                                 ELSE freezes_remaining END
    WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;