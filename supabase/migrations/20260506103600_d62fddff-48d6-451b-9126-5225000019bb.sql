CREATE OR REPLACE FUNCTION public.queue_badge_dm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  tashkent_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int;
  sched timestamptz := now();
  tashkent_today date := (now() AT TIME ZONE 'Asia/Tashkent')::date;
BEGIN
  IF tashkent_hour >= 22 OR tashkent_hour < 8 THEN
    IF tashkent_hour >= 22 THEN
      sched := ((tashkent_today + 1) + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    ELSE
      sched := (tashkent_today + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    END IF;
  END IF;
  INSERT INTO public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  VALUES (NEW.user_id, NEW.badge_id, COALESCE(NEW.earned_at, now()), sched);
  RETURN NEW;
END;
$function$;