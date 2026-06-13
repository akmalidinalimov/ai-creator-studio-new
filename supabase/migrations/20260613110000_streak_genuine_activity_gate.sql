-- ============================================================================
-- Recognition integrity (owner decision 2026-06-13): streaks must reflect
-- GENUINE engagement, not phantom activity. Root cause of the reported
-- "3-day streak without watching": update_streak_for_user fired on ANY
-- lesson_progress write (incl. 0-second lesson opens) with no activity check.
--
-- New rule: a streak day counts if the student did ANY of:
--   (a) genuinely watched a lesson (>=30s that day) or completed one, OR
--   (b) posted in a group module topic, OR
--   (c) submitted homework.
-- ============================================================================

-- 1) Shared, read-only "did this user genuinely engage on date D?" predicate.
--    Used by the reconcile job and (later) the inactivity-nudge candidate query.
CREATE OR REPLACE FUNCTION public.had_genuine_activity_on_date(
  p_user_id uuid,
  p_date date DEFAULT (now() AT TIME ZONE 'Asia/Tashkent')::date
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (  -- (a1) genuinely watched a lesson that day (per-day watch rollup)
      SELECT 1 FROM public.daily_watch_summary d
      WHERE d.user_id = p_user_id AND d.watch_date = p_date
        AND COALESCE(d.total_seconds, 0) >= 30
    )
    OR EXISTS (  -- (a2) completed a lesson that day
      SELECT 1 FROM public.lesson_progress lp
      WHERE lp.user_id = p_user_id
        AND lp.completed_at IS NOT NULL
        AND (lp.completed_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
    )
    OR EXISTS (  -- (b) posted in a group module topic that day
      SELECT 1 FROM public.group_message_events g
      WHERE g.profile_id = p_user_id
        AND g.telegram_thread_id IS NOT NULL
        AND (g.sent_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
    )
    OR EXISTS (  -- (c) submitted homework that day
      SELECT 1 FROM public.homework_submissions h
      WHERE h.user_id = p_user_id
        AND (h.submitted_at AT TIME ZONE 'Asia/Tashkent')::date = p_date
    );
$$;

-- 2) Streak day-math extracted so ANY genuine activity can advance the streak
--    (not just lesson_progress). Preserves Asia/Tashkent accounting + the
--    +1 freeze refill every 7 days (cap 2). Idempotent per day.
CREATE OR REPLACE FUNCTION public.bump_streak_for_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  today_d DATE := (now() AT TIME ZONE 'Asia/Tashkent')::date;
  last_d DATE;
  cur INT;
  longest INT;
BEGIN
  SELECT last_active_date, current_streak, longest_streak
    INTO last_d, cur, longest
    FROM public.streaks WHERE user_id = p_user_id;

  IF last_d IS NULL THEN
    INSERT INTO public.streaks (user_id, current_streak, longest_streak, last_active_date)
      VALUES (p_user_id, 1, 1, today_d)
      ON CONFLICT (user_id) DO UPDATE
        SET current_streak = 1,
            longest_streak = GREATEST(public.streaks.longest_streak, 1),
            last_active_date = today_d;
    RETURN;
  END IF;

  IF last_d = today_d THEN
    RETURN;  -- already counted today
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
    WHERE user_id = p_user_id;
END;
$$;

-- 3) Lesson-progress trigger now GATES on genuine watch (a 0-second open no
--    longer bumps the streak). Same trigger wiring (AFTER INSERT OR UPDATE).
CREATE OR REPLACE FUNCTION public.update_streak_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.completed_at IS NOT NULL) OR (COALESCE(NEW.watch_seconds_total, 0) >= 30) THEN
    PERFORM public.bump_streak_for_user(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

-- 4) Group activity keeps the streak alive (owner: "active in their Telegram group").
--    Exception-guarded so a streak hiccup never blocks group-message recording.
CREATE OR REPLACE FUNCTION public.streak_on_group_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.profile_id IS NOT NULL AND NEW.telegram_thread_id IS NOT NULL THEN
    BEGIN
      PERFORM public.bump_streak_for_user(NEW.profile_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_group_activity_streak ON public.group_message_events;
CREATE TRIGGER trg_group_activity_streak
  AFTER INSERT ON public.group_message_events
  FOR EACH ROW EXECUTE FUNCTION public.streak_on_group_activity();

-- 5) Homework submission keeps the streak alive. Exception-guarded so a streak
--    hiccup never blocks the submission insert.
CREATE OR REPLACE FUNCTION public.streak_on_homework_submit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    BEGIN
      PERFORM public.bump_streak_for_user(NEW.user_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_homework_streak ON public.homework_submissions;
CREATE TRIGGER trg_homework_streak
  AFTER INSERT ON public.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION public.streak_on_homework_submit();

GRANT EXECUTE ON FUNCTION public.had_genuine_activity_on_date(uuid, date) TO authenticated;
