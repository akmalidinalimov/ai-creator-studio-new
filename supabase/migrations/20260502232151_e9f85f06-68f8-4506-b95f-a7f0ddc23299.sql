
CREATE TABLE IF NOT EXISTS public.re_engagement_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  template_uz text NOT NULL DEFAULT '',
  template_ru text NOT NULL DEFAULT '',
  template_en text NOT NULL DEFAULT '',
  button_text_uz text NOT NULL DEFAULT '🚀 O''qishni boshlash',
  button_text_ru text NOT NULL DEFAULT '🚀 Начать обучение',
  button_text_en text NOT NULL DEFAULT '🚀 Start learning',
  cadence_days integer[] NOT NULL DEFAULT ARRAY[0,3,7,14],
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
ALTER TABLE public.re_engagement_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "re_camp admin all" ON public.re_engagement_campaigns
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE TABLE IF NOT EXISTS public.re_engagement_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.re_engagement_campaigns(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  attempt_num integer NOT NULL DEFAULT 1,
  magic_token text,
  telegram_message_id text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  clicked_at timestamptz,
  activated_at timestamptz,
  status text NOT NULL DEFAULT 'sent',
  error text
);
CREATE INDEX IF NOT EXISTS re_deliv_profile_camp ON public.re_engagement_deliveries(profile_id, campaign_id);
CREATE INDEX IF NOT EXISTS re_deliv_sent_at ON public.re_engagement_deliveries(sent_at DESC);
CREATE INDEX IF NOT EXISTS re_deliv_token ON public.re_engagement_deliveries(magic_token);
CREATE UNIQUE INDEX IF NOT EXISTS re_deliv_unique_attempt ON public.re_engagement_deliveries(campaign_id, profile_id, attempt_num);
ALTER TABLE public.re_engagement_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "re_deliv admin all" ON public.re_engagement_deliveries
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

CREATE OR REPLACE FUNCTION public.re_engagement_eligible_count()
RETURNS TABLE(never_logged_in int, with_tg int, without_tg int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin'::app_role) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE p.telegram_id IS NOT NULL)::int,
    count(*) FILTER (WHERE p.telegram_id IS NULL)::int
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.last_sign_in_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role IN ('admin','teacher'));
END;
$$;

CREATE OR REPLACE FUNCTION public.re_engagement_eligible_profiles()
RETURNS TABLE(id uuid, name text, last_name text, email text, telegram_id bigint, telegram_username citext, preferred_locale text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin'::app_role) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT p.id, p.name, p.last_name, p.email, p.telegram_id, p.telegram_username, p.preferred_locale
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.last_sign_in_at IS NULL
    AND p.telegram_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role IN ('admin','teacher'));
END;
$$;

CREATE OR REPLACE FUNCTION public.re_engagement_mark_activation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.watch_seconds_total,0) >= 30 THEN
    UPDATE public.re_engagement_deliveries d
       SET activated_at = now()
     WHERE d.profile_id = NEW.user_id
       AND d.activated_at IS NULL
       AND d.id = (
         SELECT id FROM public.re_engagement_deliveries
         WHERE profile_id = NEW.user_id ORDER BY sent_at DESC LIMIT 1
       );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_re_activation ON public.lesson_progress;
CREATE TRIGGER trg_re_activation
AFTER INSERT OR UPDATE ON public.lesson_progress
FOR EACH ROW EXECUTE FUNCTION public.re_engagement_mark_activation();

INSERT INTO public.re_engagement_campaigns (name, enabled, template_uz, template_ru, template_en)
SELECT 'Hech qachon kirmagan — boshlang''ich',
  false,
  E'Salom {{name}}! 👋\n\nAI Creators platformasiga ro''yxatdan o''tgansiz, ammo hali kirmadingiz. Bepul kirib, birinchi darsni boshlash uchun pastdagi tugmani bosing — parol kerak emas.\n\n🎁 Sizni 14 soatlik kurs kutmoqda.',
  E'Привет {{name}}! 👋\n\nВы зарегистрированы на AI Creators, но ещё не входили. Нажмите кнопку ниже, чтобы войти и начать первый урок — пароль не нужен.\n\n🎁 Вас ждёт 14-часовой курс.',
  E'Hi {{name}}! 👋\n\nYou registered for AI Creators but haven''t logged in yet. Tap below to sign in and start your first lesson — no password needed.\n\n🎁 A 14-hour course is waiting for you.'
WHERE NOT EXISTS (SELECT 1 FROM public.re_engagement_campaigns);
