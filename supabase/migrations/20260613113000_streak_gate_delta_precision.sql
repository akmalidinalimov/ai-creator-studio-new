-- Precision fix for the streak gate. The previous gate checked
-- NEW.watch_seconds_total >= 30, but watch_seconds_total is CUMULATIVE — so
-- merely re-opening a lesson you already watched (0 new seconds) would still
-- pass the gate and bump the streak. Gate on the per-EVENT delta instead:
-- bump only when this write genuinely advanced watching or just completed.
CREATE OR REPLACE FUNCTION public.update_streak_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- fresh row that already represents genuine watching/completion
    IF (NEW.completed_at IS NOT NULL) OR (COALESCE(NEW.watch_seconds_total, 0) >= 30) THEN
      PERFORM public.bump_streak_for_user(NEW.user_id);
    END IF;
  ELSE  -- UPDATE: require real progress on THIS event
    IF (NEW.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
       OR (COALESCE(NEW.watch_seconds_total, 0) > COALESCE(OLD.watch_seconds_total, 0))
    THEN
      PERFORM public.bump_streak_for_user(NEW.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
