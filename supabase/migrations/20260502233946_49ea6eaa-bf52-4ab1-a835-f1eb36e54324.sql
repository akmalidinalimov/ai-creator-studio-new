-- Profile column for local time
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tashkent_offset_minutes integer NOT NULL DEFAULT 300;

-- nudge_preferences
CREATE TABLE IF NOT EXISTS public.nudge_preferences (
  profile_id uuid PRIMARY KEY,
  opt_in boolean NOT NULL DEFAULT true,
  paused_until date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.nudge_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "np own select" ON public.nudge_preferences
  FOR SELECT TO authenticated
  USING (auth.uid() = profile_id OR has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "np own upsert" ON public.nudge_preferences
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = profile_id OR has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "np own update" ON public.nudge_preferences
  FOR UPDATE TO authenticated
  USING (auth.uid() = profile_id OR has_role(auth.uid(), 'admin'::app_role));

-- nudge_log
CREATE TABLE IF NOT EXISTS public.nudge_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL,
  nudge_type text NOT NULL CHECK (nudge_type IN ('inactive_3d','inactive_7d','stuck_lesson','module_complete')),
  telegram_message_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  magic_token text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  clicked_at timestamptz,
  error text
);
CREATE INDEX IF NOT EXISTS idx_nudge_log_profile_sent ON public.nudge_log (profile_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_nudge_log_type_sent ON public.nudge_log (nudge_type, sent_at DESC);
ALTER TABLE public.nudge_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "nudge_log admin all" ON public.nudge_log
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- module celebrations
CREATE TABLE IF NOT EXISTS public.nudge_module_celebrations (
  profile_id uuid NOT NULL,
  module_id uuid NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (profile_id, module_id)
);
ALTER TABLE public.nudge_module_celebrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "nmc admin all" ON public.nudge_module_celebrations
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Trigger: when a lesson is completed, if it's the last lesson of its module for this student → enqueue celebration
CREATE OR REPLACE FUNCTION public.trg_enqueue_module_complete_nudge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_module_id uuid;
  v_total int;
  v_done int;
BEGIN
  IF NEW.completed_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.completed_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT module_id INTO v_module_id FROM public.lessons WHERE id = NEW.lesson_id;
  IF v_module_id IS NULL THEN RETURN NEW; END IF;

  SELECT COUNT(*) INTO v_total FROM public.lessons WHERE module_id = v_module_id AND published = true;
  SELECT COUNT(DISTINCT lp.lesson_id) INTO v_done
    FROM public.lesson_progress lp
    JOIN public.lessons l ON l.id = lp.lesson_id
   WHERE lp.user_id = NEW.user_id AND l.module_id = v_module_id AND lp.completed_at IS NOT NULL;

  IF v_total > 0 AND v_done >= v_total THEN
    INSERT INTO public.nudge_module_celebrations (profile_id, module_id)
    VALUES (NEW.user_id, v_module_id)
    ON CONFLICT (profile_id, module_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_module_complete ON public.lesson_progress;
CREATE TRIGGER trg_enqueue_module_complete
  AFTER INSERT OR UPDATE OF completed_at ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_module_complete_nudge();

-- Updated_at trigger for prefs
DROP TRIGGER IF EXISTS trg_np_updated ON public.nudge_preferences;
CREATE TRIGGER trg_np_updated BEFORE UPDATE ON public.nudge_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default templates in platform_settings
INSERT INTO public.platform_settings (key, value)
VALUES ('nudge_templates', '{
  "inactive_3d": {
    "uz": {"body":"Salom {{name}}! 👋 Sog''inib qoldik. Bugun bitta dars ko''ring va streakingizni saqlang 🔥","button":"🚀 Davom etish"},
    "ru": {"body":"Привет, {{name}}! 👋 Соскучились. Посмотри один урок сегодня и сохрани свой стрик 🔥","button":"🚀 Продолжить"},
    "en": {"body":"Hi {{name}}! 👋 We miss you. Watch one lesson today and keep your streak 🔥","button":"🚀 Continue"}
  },
  "inactive_7d": {
    "uz": {"body":"{{name}}, qaytib keling 🙏 {{teacher_line}}Bitta dars — 8 daqiqa.","button":"🚀 Boshlash"},
    "ru": {"body":"{{name}}, возвращайтесь 🙏 {{teacher_line}}Один урок — 8 минут.","button":"🚀 Начать"},
    "en": {"body":"{{name}}, come back 🙏 {{teacher_line}}One lesson — 8 minutes.","button":"🚀 Start"}
  },
  "stuck_lesson": {
    "uz": {"body":"Ushbu darsda yordam kerakmi? Mana qisqacha tushuntirish 👇\n{{lesson_title}}","button":"📖 Qayta ko''rish"},
    "ru": {"body":"Нужна помощь с этим уроком? Краткое объяснение 👇\n{{lesson_title}}","button":"📖 Пересмотреть"},
    "en": {"body":"Need help with this lesson? Quick recap 👇\n{{lesson_title}}","button":"📖 Rewatch"}
  },
  "module_complete": {
    "uz": {"body":"🎉 Tabriklaymiz {{name}}! {{module_name}} modulini tugatdingiz! Endi keyingi modulga o''ting.","button":"📚 Keyingi modul"},
    "ru": {"body":"🎉 Поздравляем {{name}}! Вы завершили модуль {{module_name}}! Переходите к следующему.","button":"📚 Следующий модуль"},
    "en": {"body":"🎉 Congrats {{name}}! You finished {{module_name}}! On to the next module.","button":"📚 Next module"}
  }
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Cron status helpers
CREATE OR REPLACE FUNCTION public.nudge_cron_status()
RETURNS TABLE(jobname text, active boolean, schedule text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT jobname::text, active, schedule::text FROM cron.job WHERE jobname = 'detect_and_nudge';
$$;

CREATE OR REPLACE FUNCTION public.nudge_cron_set_enabled(_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE cron.job SET active = _enabled WHERE jobname = 'detect_and_nudge';
END;
$$;

REVOKE ALL ON FUNCTION public.nudge_cron_set_enabled(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_cron_set_enabled(boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.nudge_cron_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nudge_cron_status() TO authenticated;