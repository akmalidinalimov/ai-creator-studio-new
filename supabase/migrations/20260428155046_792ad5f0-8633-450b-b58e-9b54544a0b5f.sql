-- Enable pg_net for async HTTP calls from the database
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Profile notification preferences
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS reminder_time time NOT NULL DEFAULT '20:00:00',
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_daily_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_streak_warning_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_inactive_warning_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_inactive_warning_day integer;

-- Default timezone to Asia/Tashkent for any rows currently on UTC
UPDATE public.profiles SET timezone = 'Asia/Tashkent' WHERE timezone IS NULL OR timezone = 'UTC';
ALTER TABLE public.profiles ALTER COLUMN timezone SET DEFAULT 'Asia/Tashkent';

-- Notifications log
CREATE TABLE IF NOT EXISTS public.notifications_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_log_user_type_sent
  ON public.notifications_log (user_id, notification_type, sent_at DESC);

ALTER TABLE public.notifications_log ENABLE ROW LEVEL SECURITY;

-- Admin read for analytics; no client writes (service role bypasses RLS)
DROP POLICY IF EXISTS "notifications_log admin read" ON public.notifications_log;
CREATE POLICY "notifications_log admin read"
  ON public.notifications_log FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Update track_video_progress to fire async notify-completion on first completion
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
  edge_url text;
  service_key text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Check whether already completed before write
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
    duration_seconds_v2 = COALESCE(public.lesson_progress.duration_seconds_v2, NULLIF(dur, 0)),
    updated_at = now_ts
  RETURNING max_position_seconds, COALESCE(duration_seconds_v2, NULLIF(dur, 0)) INTO new_max, new_dur;

  IF new_dur IS NOT NULL AND new_dur > 0 AND (new_max / new_dur) >= 0.9 THEN
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

  -- Fire async celebration ONLY on first completion transition
  IF is_complete AND NOT was_already_complete THEN
    BEGIN
      edge_url := current_setting('app.edge_base_url', true);
      service_key := current_setting('app.service_role_key', true);
      IF edge_url IS NOT NULL AND edge_url <> '' AND service_key IS NOT NULL AND service_key <> '' THEN
        PERFORM extensions.http_post(
          url := edge_url || '/functions/v1/notify-completion',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
          ),
          body := jsonb_build_object('user_id', uid, 'lesson_id', p_lesson_id)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Never fail progress tracking if notification dispatch fails
      NULL;
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