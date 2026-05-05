CREATE TABLE IF NOT EXISTS public.badge_award_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  badge_id uuid NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_baq_pending ON public.badge_award_queue (scheduled_for) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_baq_user ON public.badge_award_queue (user_id);

ALTER TABLE public.badge_award_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "baq admin read" ON public.badge_award_queue FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.queue_badge_dm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tashkent_now timestamptz := now() AT TIME ZONE 'Asia/Tashkent';
  tashkent_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int;
  sched timestamptz := now();
  tashkent_today date := (now() AT TIME ZONE 'Asia/Tashkent')::date;
BEGIN
  IF tashkent_hour >= 22 OR tashkent_hour < 8 THEN
    -- Schedule for next 08:00 Tashkent local
    IF tashkent_hour >= 22 THEN
      sched := ((tashkent_today + 1) + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    ELSE
      sched := (tashkent_today + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    END IF;
  END IF;
  INSERT INTO public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  VALUES (NEW.user_id, NEW.badge_id, COALESCE(NEW.awarded_at, now()), sched);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_badge_dm ON public.user_badges;
CREATE TRIGGER trg_queue_badge_dm
  AFTER INSERT ON public.user_badges
  FOR EACH ROW EXECUTE FUNCTION public.queue_badge_dm();

ALTER TABLE public.telegram_magic_links DROP CONSTRAINT IF EXISTS telegram_magic_links_purpose_check;
ALTER TABLE public.telegram_magic_links
  ADD CONSTRAINT telegram_magic_links_purpose_check
  CHECK (purpose IN (
    'login','deeplink_lesson','deeplink_course',
    'reengagement','re_engagement',
    'nudge','nudge_inactive_3d','nudge_inactive_7d','nudge_stuck_lesson','nudge_module_complete',
    'cert_celebration','reset_password','email_confirm','badge_celebration'
  ));