-- Align the live streak trigger with the canonical genuine-activity definition (audit 2026-06-19).
-- Before: the UPDATE path bumped the streak on ANY positive watch delta (as little as 1s), but
-- had_genuine_activity_on_date / the reconcile require >=30s of watching that day. So a displayed
-- streak could grow on activity a future reconcile would then truncate (the exact regression that
-- damaged loyal students). Now the watch path bumps only once today's Tashkent-dated
-- daily_watch_summary rollup (including this event) reaches 30s; completions always count.
-- bump_streak_for_user is idempotent per day, so re-bumping within the day is a no-op.
CREATE OR REPLACE FUNCTION public.update_streak_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _delta numeric;
  _today numeric;
BEGIN
  -- A genuine completion always advances the streak.
  IF NEW.completed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    PERFORM public.bump_streak_for_user(NEW.user_id);
    RETURN NEW;
  END IF;

  -- Genuine watching on THIS event (per-event delta, not a cumulative re-open).
  _delta := COALESCE(NEW.watch_seconds_total, 0)
            - CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.watch_seconds_total, 0) END;
  IF _delta > 0 THEN
    SELECT COALESCE(total_seconds, 0) INTO _today
    FROM public.daily_watch_summary
    WHERE user_id = NEW.user_id
      AND watch_date = (now() AT TIME ZONE 'Asia/Tashkent')::date;
    -- daily_watch_summary for today is written AFTER this trigger fires (in track_video_progress),
    -- so add this event's delta to the pre-event rollup to decide if today crosses the 30s bar.
    IF COALESCE(_today, 0) + _delta >= 30 THEN
      PERFORM public.bump_streak_for_user(NEW.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
