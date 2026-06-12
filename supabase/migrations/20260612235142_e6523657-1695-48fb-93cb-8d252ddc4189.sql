-- 1. Make streak day-accounting use Asia/Tashkent consistently (was UTC).
--    This is the existing function from migration 20260610063759 with ONLY the timezone changed.
CREATE OR REPLACE FUNCTION public.update_streak_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today_d DATE := (now() AT TIME ZONE 'Asia/Tashkent')::date;
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

-- 2. Remove duplicate/legacy cron jobs (keep: zero-broken-streaks at 0 19 * * *, recalc-leaderboard at */15).
--    Guard each unschedule so the migration succeeds even if a job is already gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'streak_rollover') THEN
    PERFORM cron.unschedule('streak_rollover');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'leaderboard_recalc') THEN
    PERFORM cron.unschedule('leaderboard_recalc');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'leaderboard-recalc-daily') THEN
    PERFORM cron.unschedule('leaderboard-recalc-daily');
  END IF;
END $$;