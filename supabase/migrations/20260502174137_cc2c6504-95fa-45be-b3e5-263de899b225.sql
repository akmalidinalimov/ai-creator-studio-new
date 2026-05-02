-- 1) admin_notification_log: dedup/rate-limit for admin-targeted bot messages
CREATE TABLE IF NOT EXISTS public.admin_notification_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  notification_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_log_user_type_sent
  ON public.admin_notification_log (user_id, notification_type, sent_at DESC);

ALTER TABLE public.admin_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_notification_log admin read"
  ON public.admin_notification_log
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- No insert/update/delete policies: only service_role (edge functions) writes.

-- 2) Seed admin notification templates (5 keys × 3 locales)
INSERT INTO public.notification_templates (template_key, locale, body, button_label) VALUES
  ('admin_daily_brief', 'uz',
$$🌅 <b>Bugungi brief</b> — {{date}}

👥 Jami talabalar: <b>{{total}}</b>
✅ Faol bugun: <b>{{today_active}}</b>
🔑 Bir marta kirgan: <b>{{ever_logged_in}}</b>
🚫 Hech kirmagan: <b>{{never}}</b>

⚠️ 3 kun faol bo'lmagan: <b>{{inactive_3d}}</b>
🔴 7 kun faol bo'lmagan: <b>{{inactive_7d}}</b>

🎓 Kursni tugatganlar: <b>{{course_completed}}</b>$$,
   '📊 Batafsil analitika'),

  ('admin_daily_brief', 'ru',
$$🌅 <b>Сводка на сегодня</b> — {{date}}

👥 Всего студентов: <b>{{total}}</b>
✅ Активны сегодня: <b>{{today_active}}</b>
🔑 Хотя бы раз входили: <b>{{ever_logged_in}}</b>
🚫 Никогда не входили: <b>{{never}}</b>

⚠️ Неактивны 3 дня: <b>{{inactive_3d}}</b>
🔴 Неактивны 7 дней: <b>{{inactive_7d}}</b>

🎓 Завершили курс: <b>{{course_completed}}</b>$$,
   '📊 Подробная аналитика'),

  ('admin_daily_brief', 'en',
$$🌅 <b>Daily brief</b> — {{date}}

👥 Total students: <b>{{total}}</b>
✅ Active today: <b>{{today_active}}</b>
🔑 Ever logged in: <b>{{ever_logged_in}}</b>
🚫 Never logged in: <b>{{never}}</b>

⚠️ Inactive 3 days: <b>{{inactive_3d}}</b>
🔴 Inactive 7 days: <b>{{inactive_7d}}</b>

🎓 Course completed: <b>{{course_completed}}</b>$$,
   '📊 Full analytics'),

  ('admin_new_student', 'uz',
   '👤 Yangi talaba qo''shildi: <b>{{name}}</b> (@{{username}})',
   NULL),
  ('admin_new_student', 'ru',
   '👤 Новый студент: <b>{{name}}</b> (@{{username}})',
   NULL),
  ('admin_new_student', 'en',
   '👤 New student enrolled: <b>{{name}}</b> (@{{username}})',
   NULL),

  ('admin_inactive_3d_digest', 'uz',
$$⚠️ <b>3 kun faol bo'lmagan talabalar</b>

{{student_list}}

Ulardan <b>{{count}}</b> ta bugun ushbu chegaraga yetdi.$$,
   '📥 To''liq ro''yxat CSV'),
  ('admin_inactive_3d_digest', 'ru',
$$⚠️ <b>Неактивны 3 дня</b>

{{student_list}}

Из них <b>{{count}}</b> достигли порога сегодня.$$,
   '📥 Полный список CSV'),
  ('admin_inactive_3d_digest', 'en',
$$⚠️ <b>Inactive for 3 days</b>

{{student_list}}

<b>{{count}}</b> of them crossed the threshold today.$$,
   '📥 Full list CSV'),

  ('admin_inactive_7d_digest', 'uz',
$$🔴 <b>7 kun faol bo'lmagan talabalar (kritik)</b>

{{student_list}}

Ulardan <b>{{count}}</b> ta bugun ushbu chegaraga yetdi.$$,
   '📥 To''liq ro''yxat CSV'),
  ('admin_inactive_7d_digest', 'ru',
$$🔴 <b>Неактивны 7 дней (критично)</b>

{{student_list}}

Из них <b>{{count}}</b> достигли порога сегодня.$$,
   '📥 Полный список CSV'),
  ('admin_inactive_7d_digest', 'en',
$$🔴 <b>Inactive for 7 days (critical)</b>

{{student_list}}

<b>{{count}}</b> of them crossed the threshold today.$$,
   '📥 Full list CSV'),

  ('admin_course_completion', 'uz',
   '🎉 <b>{{name}}</b> (@{{username}}) kursni 100% tugatdi! Sertifikat tayyorlandi.',
   NULL),
  ('admin_course_completion', 'ru',
   '🎉 <b>{{name}}</b> (@{{username}}) завершил(а) курс на 100%! Сертификат готов.',
   NULL),
  ('admin_course_completion', 'en',
   '🎉 <b>{{name}}</b> (@{{username}}) completed the course 100%! Certificate is ready.',
   NULL)
ON CONFLICT (template_key, locale) DO NOTHING;

-- 3) Register variables for each admin template
INSERT INTO public.notification_template_variables (template_key, variable_name, description) VALUES
  ('admin_daily_brief', 'date',             'Today''s date (YYYY-MM-DD)'),
  ('admin_daily_brief', 'total',            'Total students enrolled'),
  ('admin_daily_brief', 'today_active',     'Students active today'),
  ('admin_daily_brief', 'ever_logged_in',   'Students who logged in at least once'),
  ('admin_daily_brief', 'never',            'Students who never logged in'),
  ('admin_daily_brief', 'inactive_3d',      'Students inactive for 3+ days'),
  ('admin_daily_brief', 'inactive_7d',      'Students inactive for 7+ days'),
  ('admin_daily_brief', 'course_completed', 'Students who completed the course'),

  ('admin_new_student', 'name',     'Student full name'),
  ('admin_new_student', 'username', 'Telegram username (without @)'),

  ('admin_inactive_3d_digest', 'count',        'Number of students newly crossing 3-day threshold today'),
  ('admin_inactive_3d_digest', 'student_list', 'Newline-separated list of names + @usernames'),

  ('admin_inactive_7d_digest', 'count',        'Number of students newly crossing 7-day threshold today'),
  ('admin_inactive_7d_digest', 'student_list', 'Newline-separated list of names + @usernames'),

  ('admin_course_completion', 'name',     'Student full name'),
  ('admin_course_completion', 'username', 'Telegram username (without @)')
ON CONFLICT DO NOTHING;