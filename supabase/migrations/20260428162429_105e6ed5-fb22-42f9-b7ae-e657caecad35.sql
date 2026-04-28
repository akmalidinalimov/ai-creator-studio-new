
-- v2.0.1 — Notification templates: admin-editable bot copy
CREATE TABLE IF NOT EXISTS public.notification_templates (
  template_key text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('uz','ru','en')),
  body text NOT NULL,
  button_label text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (template_key, locale)
);

CREATE TABLE IF NOT EXISTS public.notification_template_variables (
  template_key text NOT NULL,
  variable_name text NOT NULL,
  description text,
  PRIMARY KEY (template_key, variable_name)
);

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_template_variables ENABLE ROW LEVEL SECURITY;

-- Only admins can read or update; no INSERT or DELETE policies (blocked from client)
CREATE POLICY "notification_templates admin select"
  ON public.notification_templates FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "notification_templates admin update"
  ON public.notification_templates FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "notification_template_variables admin select"
  ON public.notification_template_variables FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Trigger to track updated_at and updated_by
CREATE OR REPLACE FUNCTION public.set_notification_template_meta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.updated_by = auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notification_templates_meta ON public.notification_templates;
CREATE TRIGGER notification_templates_meta
  BEFORE UPDATE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_notification_template_meta();

-- Seed variable metadata
INSERT INTO public.notification_template_variables (template_key, variable_name, description) VALUES
  ('daily_reminder','first_name','Foydalanuvchining ismi'),
  ('streak_warning','first_name','Foydalanuvchining ismi'),
  ('streak_warning','streak_days','Joriy g''alaba kunlari soni'),
  ('lesson_complete','first_name','Foydalanuvchining ismi'),
  ('lesson_complete','lesson_title','Tugatilgan dars nomi'),
  ('lesson_complete','next_lesson_title','Keyingi dars nomi'),
  ('module_complete','first_name','Foydalanuvchining ismi'),
  ('module_complete','module_number','Modul raqami'),
  ('module_complete','lessons_done','Modulda tugatilgan darslar'),
  ('module_complete','lessons_total','Modulda jami darslar'),
  ('module_complete','minutes','O''rganilgan daqiqalar'),
  ('course_complete','first_name','Foydalanuvchining ismi'),
  ('course_complete','full_name','To''liq ism'),
  ('course_complete','course_title','Kurs nomi'),
  ('inactive_3','first_name','Foydalanuvchining ismi'),
  ('inactive_7','first_name','Foydalanuvchining ismi'),
  ('inactive_14','first_name','Foydalanuvchining ismi'),
  ('settings_confirm','first_name','Foydalanuvchining ismi')
ON CONFLICT DO NOTHING;

-- Seed templates (uz, ru, en) for all 9 keys
INSERT INTO public.notification_templates (template_key, locale, body, button_label) VALUES
  -- daily_reminder
  ('daily_reminder','uz','Salom, {{first_name}}! Bugun kursda davom etamizmi? 📚','Davom etish →'),
  ('daily_reminder','ru','Привет, {{first_name}}! Продолжим обучение сегодня? 📚','Продолжить →'),
  ('daily_reminder','en','Hi {{first_name}}! Continue learning today? 📚','Continue →'),
  -- streak_warning
  ('streak_warning','uz','🔥 {{streak_days}} kunlik g''alabangizni saqlang! Bugun bittagina dars qoldi.','⚡ Hoziroq davom etish'),
  ('streak_warning','ru','🔥 Сохраните победу в {{streak_days}} дней! Сегодня остался один урок.','⚡ Продолжить сейчас'),
  ('streak_warning','en','🔥 Keep your {{streak_days}}-day streak alive! One lesson left today.','⚡ Continue now'),
  -- lesson_complete
  ('lesson_complete','uz','🎬 Darsni tugatdingiz: <b>{{lesson_title}}</b>

Keyingi dars: {{next_lesson_title}}','Keyingi dars →'),
  ('lesson_complete','ru','🎬 Урок завершён: <b>{{lesson_title}}</b>

Следующий урок: {{next_lesson_title}}','Следующий урок →'),
  ('lesson_complete','en','🎬 Lesson completed: <b>{{lesson_title}}</b>

Next lesson: {{next_lesson_title}}','Next lesson →'),
  -- module_complete
  ('module_complete','uz','🎉 <b>Modul {{module_number}} tugadi!</b>

📊 {{lessons_done}}/{{lessons_total}} dars
⏱ {{minutes}} daqiqa o''rgandingiz

Keyingi modulga o''tasizmi?','Keyingi modul →'),
  ('module_complete','ru','🎉 <b>Модуль {{module_number}} завершён!</b>

📊 {{lessons_done}}/{{lessons_total}} уроков
⏱ {{minutes}} минут обучения

Перейти к следующему модулю?','Следующий модуль →'),
  ('module_complete','en','🎉 <b>Module {{module_number}} completed!</b>

📊 {{lessons_done}}/{{lessons_total}} lessons
⏱ {{minutes}} minutes studied

Move to the next module?','Next module →'),
  -- course_complete
  ('course_complete','uz','🎓 Tabriklaymiz, <b>{{first_name}}</b>! Siz AI Creators kursini muvaffaqiyatli tugatdingiz!

📜 Sertifikatingiz tayyor.','📤 Ulashish'),
  ('course_complete','ru','🎓 Поздравляем, <b>{{first_name}}</b>! Вы успешно завершили курс AI Creators!

📜 Ваш сертификат готов.','📤 Поделиться'),
  ('course_complete','en','🎓 Congratulations, <b>{{first_name}}</b>! You''ve successfully completed the AI Creators course!

📜 Your certificate is ready.','📤 Share'),
  -- inactive_3
  ('inactive_3','uz','Sog''indik sizni 👋 Kursdan davom etamizmi?','Davom etish →'),
  ('inactive_3','ru','Соскучились по вам 👋 Продолжим курс?','Продолжить →'),
  ('inactive_3','en','We miss you 👋 Want to continue the course?','Continue →'),
  -- inactive_7
  ('inactive_7','uz','{{first_name}}, kursingiz sizni kutmoqda. Birga davom etaylik?','Boshlash →'),
  ('inactive_7','ru','{{first_name}}, ваш курс ждёт вас. Продолжим вместе?','Начать →'),
  ('inactive_7','en','{{first_name}}, your course is waiting. Continue together?','Start →'),
  -- inactive_14
  ('inactive_14','uz','Sizga maxsus xabar bor — qaytib keling va bonusni oling 🎁','Tafsilotlar →'),
  ('inactive_14','ru','У нас для вас особое сообщение — вернитесь и заберите бонус 🎁','Подробнее →'),
  ('inactive_14','en','We have a special message for you — come back and grab the bonus 🎁','Details →'),
  -- settings_confirm
  ('settings_confirm','uz','✅ Sozlamalar saqlandi.',NULL),
  ('settings_confirm','ru','✅ Настройки сохранены.',NULL),
  ('settings_confirm','en','✅ Settings saved.',NULL)
ON CONFLICT (template_key, locale) DO NOTHING;

-- ============== LINTER CLEANUP ==============

-- 1) Move pg_cron and pg_net from public schema to extensions schema
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_net' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION pg_net SET SCHEMA extensions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_cron' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER EXTENSION pg_cron SET SCHEMA extensions';
  END IF;
END $$;

-- 2) Lock down SECURITY DEFINER function execution to authenticated only (or admin-via-RLS).
--    Revoke from PUBLIC and anon. Keep authenticated where the function is intentionally callable.
DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef = true
      AND n.nspname = 'public'
      AND p.proname IN (
        'admin_course_progress','admin_list_users','get_public_setting','has_role',
        'match_ai_knowledge','track_video_progress','update_streak_for_user',
        'handle_new_user','update_updated_at_column','set_notification_template_meta'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
  END LOOP;
END $$;

-- Trigger functions don't need any EXECUTE grants
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_streak_for_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.set_notification_template_meta() FROM authenticated;

-- Admin-only functions: only authenticated users can attempt to call; the function body re-checks has_role.
-- (No-op if already authenticated by default; explicit grant for clarity.)
GRANT EXECUTE ON FUNCTION public.admin_course_progress(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge(vector, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.track_video_progress(uuid, numeric, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_setting(text) TO authenticated;
