
-- 1a. Tracking table
CREATE TABLE IF NOT EXISTS public.homework_ungraded_reminders (
  submission_id uuid PRIMARY KEY REFERENCES public.homework_submissions(id) ON DELETE CASCADE,
  reminders_sent int NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.homework_ungraded_reminders TO service_role;
ALTER TABLE public.homework_ungraded_reminders ENABLE ROW LEVEL SECURITY;
-- intentionally no policies: only the service-role edge function touches this table.

-- 1b. Schedule hourly cron mirroring notify-homework-submission shape
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ungraded-homework-reminder-hourly') THEN
    PERFORM cron.unschedule('ungraded-homework-reminder-hourly');
  END IF;
  PERFORM cron.schedule(
    'ungraded-homework-reminder-hourly',
    '0 * * * *',
    $cmd$
    SELECT net.http_post(
      url := 'https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/cron-ungraded-homework-reminder',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZHp0cmlqYXNnbXhnbGl3ZGRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNjM1NDQsImV4cCI6MjA5MjczOTU0NH0.WvupCYAhOryyjpGeoSZBG87jgC6NLRQtHHFB7CoqYAc',
        'x-internal-secret', public.internal_fn_secret()
      ),
      body := '{}'::jsonb
    );
    $cmd$
  );
END $$;
