-- Infrastructure for the Google-Sheet onboarding sync (sheet-sync + cron-import-digest).
-- All additive; does not touch existing students or the admin import path.

-- 1. System variant of admin_set_enrollment_tier: same validation + upsert, but NO auth.uid() check
--    (callable by the service-role sheet-sync fn, which has no user session). Granted to service_role only.
CREATE OR REPLACE FUNCTION public.set_enrollment_tier_system(
  _user_id uuid, _course_id uuid, _tier_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _tier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.course_tiers WHERE id = _tier_id AND course_id = _course_id
  ) THEN
    RAISE EXCEPTION 'tier does not belong to course';
  END IF;
  INSERT INTO public.enrollments (user_id, course_id, tier_id)
  VALUES (_user_id, _course_id, _tier_id)
  ON CONFLICT (user_id, course_id) DO UPDATE SET tier_id = EXCLUDED.tier_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_enrollment_tier_system(uuid, uuid, uuid) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.set_enrollment_tier_system(uuid, uuid, uuid) TO service_role;

-- 2. Optional phone captured from the sheet (nullable; not used for login).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;

-- 3. Allow system-actor audit rows (sheet imports + auto-created groups log actor_user_id = NULL).
--    Safe no-op if already nullable.
ALTER TABLE public.admin_actions ALTER COLUMN actor_user_id DROP NOT NULL;

-- 4. Evening import digest cron (~every 30 min; the edge fn sends each admin at ~18:00 their local time).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'import-digest-30min') THEN
    PERFORM cron.unschedule('import-digest-30min');
  END IF;
  PERFORM cron.schedule(
    'import-digest-30min',
    '*/30 * * * *',
    $cmd$
    SELECT net.http_post(
      url := 'https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/cron-import-digest',
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
