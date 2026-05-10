-- 1) Remove the broken certificate trigger / function (references missing public.certificates table).
DROP TRIGGER IF EXISTS trg_issue_certificate_on_progress ON public.lesson_progress;
DROP FUNCTION IF EXISTS public.trg_issue_certificate() CASCADE;
DROP FUNCTION IF EXISTS public.issue_certificate_if_eligible(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.generate_certificate_serial() CASCADE;

-- 2) Update the video-progress RPC.
CREATE OR REPLACE FUNCTION public.track_video_progress(
  p_lesson_id uuid,
  p_current_time numeric,
  p_duration numeric,
  p_delta_seconds numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  delta numeric := LEAST(GREATEST(COALESCE(p_delta_seconds, 0), 0), 10);
  cur numeric := GREATEST(COALESCE(p_current_time, 0), 0);
  dur numeric := GREATEST(COALESCE(p_duration, 0), 0);
  new_max numeric;
  new_dur numeric;
  is_complete boolean := false;
  was_already_complete boolean := false;
  now_ts timestamptz := now();
  edge_url constant text := 'https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/notify-completion';
  anon_key constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZHp0cmlqYXNnbXhnbGl3ZGRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNjM1NDQsImV4cCI6MjA5MjczOTU0NH0.WvupCYAhOryyjpGeoSZBG87jgC6NLRQtHHFB7CoqYAc';
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT (completed_at IS NOT NULL) INTO was_already_complete
    FROM public.lesson_progress
    WHERE user_id = uid AND lesson_id = p_lesson_id;
  was_already_complete := COALESCE(was_already_complete, false);

  INSERT INTO public.lesson_progress (
    user_id, lesson_id, last_position_seconds, max_position_seconds,
    watch_seconds_total, duration_seconds_v2, updated_at
  ) VALUES (
    uid, p_lesson_id, cur, cur, delta, NULLIF(dur, 0), now_ts
  )
  ON CONFLICT (user_id, lesson_id) DO UPDATE SET
    last_position_seconds = cur,
    max_position_seconds = GREATEST(public.lesson_progress.max_position_seconds, cur),
    watch_seconds_total = public.lesson_progress.watch_seconds_total + delta,
    duration_seconds_v2 = CASE
      WHEN NULLIF(dur, 0) IS NULL THEN public.lesson_progress.duration_seconds_v2
      WHEN public.lesson_progress.duration_seconds_v2 IS NULL THEN NULLIF(dur, 0)
      WHEN dur < public.lesson_progress.duration_seconds_v2 * 0.95 THEN dur
      ELSE public.lesson_progress.duration_seconds_v2
    END,
    updated_at = now_ts
  RETURNING max_position_seconds, COALESCE(duration_seconds_v2, NULLIF(dur, 0)) INTO new_max, new_dur;

  IF new_dur IS NOT NULL AND new_dur > 0
     AND ((new_max / new_dur) >= 0.85 OR new_max >= new_dur - 20) THEN
    UPDATE public.lesson_progress
      SET completed_at = COALESCE(completed_at, now_ts)
      WHERE user_id = uid AND lesson_id = p_lesson_id;
    is_complete := true;
  END IF;

  IF delta > 0 THEN
    INSERT INTO public.daily_watch_summary (user_id, watch_date, total_seconds, updated_at)
    VALUES (uid, (now_ts AT TIME ZONE 'UTC')::date, delta, now_ts)
    ON CONFLICT (user_id, watch_date) DO UPDATE
      SET total_seconds = public.daily_watch_summary.total_seconds + EXCLUDED.total_seconds,
          updated_at = now_ts;
  END IF;

  IF is_complete AND NOT was_already_complete THEN
    BEGIN
      PERFORM net.http_post(
        url := edge_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', anon_key,
          'Authorization', 'Bearer ' || anon_key
        ),
        body := jsonb_build_object('user_id', uid, 'lesson_id', p_lesson_id)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'notify-completion dispatch failed for user % lesson %: % %', uid, p_lesson_id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN jsonb_build_object(
    'completed', is_complete,
    'last_position_seconds', cur,
    'max_position_seconds', new_max,
    'duration_seconds', new_dur
  );
END;
$function$;

-- 3) Backfill: mark any in-progress lesson as completed when the student reached >=85%.
UPDATE public.lesson_progress
   SET completed_at = COALESCE(completed_at, updated_at)
 WHERE completed_at IS NULL
   AND duration_seconds_v2 IS NOT NULL
   AND duration_seconds_v2 > 0
   AND (max_position_seconds / duration_seconds_v2) >= 0.85;
