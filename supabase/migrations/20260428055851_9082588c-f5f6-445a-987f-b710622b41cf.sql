-- Add new tracking columns to lesson_progress (preserve existing PK and data)
ALTER TABLE public.lesson_progress
  ADD COLUMN IF NOT EXISTS max_position_seconds numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watch_seconds_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration_seconds_v2 numeric;

-- Backfill max from existing last_position_seconds
UPDATE public.lesson_progress
SET max_position_seconds = GREATEST(max_position_seconds, COALESCE(last_position_seconds, 0)),
    watch_seconds_total = GREATEST(watch_seconds_total, COALESCE(seconds_watched, 0));

-- Composite uniqueness for upserts on (user_id, lesson_id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lesson_progress_user_lesson_uniq'
  ) THEN
    -- Deduplicate before adding unique constraint
    DELETE FROM public.lesson_progress lp1
    USING public.lesson_progress lp2
    WHERE lp1.ctid < lp2.ctid
      AND lp1.user_id = lp2.user_id
      AND lp1.lesson_id = lp2.lesson_id;
    ALTER TABLE public.lesson_progress
      ADD CONSTRAINT lesson_progress_user_lesson_uniq UNIQUE (user_id, lesson_id);
  END IF;
END $$;

-- Daily watch summary table
CREATE TABLE IF NOT EXISTS public.daily_watch_summary (
  user_id uuid NOT NULL,
  watch_date date NOT NULL,
  total_seconds numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, watch_date)
);

ALTER TABLE public.daily_watch_summary ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_watch_summary' AND policyname = 'dws own select') THEN
    CREATE POLICY "dws own select" ON public.daily_watch_summary
      FOR SELECT USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_watch_summary' AND policyname = 'dws own insert') THEN
    CREATE POLICY "dws own insert" ON public.daily_watch_summary
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_watch_summary' AND policyname = 'dws own update') THEN
    CREATE POLICY "dws own update" ON public.daily_watch_summary
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- RPC: track_video_progress
CREATE OR REPLACE FUNCTION public.track_video_progress(
  p_lesson_id uuid,
  p_current_time numeric,
  p_duration numeric,
  p_delta_seconds numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  delta numeric := LEAST(GREATEST(COALESCE(p_delta_seconds, 0), 0), 10);
  cur numeric := GREATEST(COALESCE(p_current_time, 0), 0);
  dur numeric := GREATEST(COALESCE(p_duration, 0), 0);
  new_max numeric;
  new_dur numeric;
  is_complete boolean := false;
  now_ts timestamptz := now();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

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

  RETURN jsonb_build_object(
    'completed', is_complete,
    'last_position_seconds', cur,
    'max_position_seconds', new_max,
    'duration_seconds', new_dur
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.track_video_progress(uuid, numeric, numeric, numeric) TO authenticated;