-- (1) 30-day step for the automatic inactivity ladder (3/7/14 -> +30).
insert into public.notification_templates (template_key, locale, body, button_label)
values
  ('inactive_30','uz','{{first_name}}, bir oy bo''ldi — kursingiz va guruhingiz sizni hali ham kutmoqda 💚 Bitta darsdan qayta boshlaymizmi?','Qaytish →'),
  ('inactive_30','ru','{{first_name}}, прошёл месяц — курс и ваша группа всё ещё ждут вас 💚 Начнём заново с одного урока?','Вернуться →'),
  ('inactive_30','en','{{first_name}}, it''s been a month — your course and your group are still here for you 💚 Restart with one lesson?','Come back →')
on conflict do nothing;

-- (2) Weekly teacher digest: Monday 04:00 UTC (09:00 Tashkent) — the smart
-- hand-off between automatic reminders and the teacher's personal nudge.
select cron.schedule(
  'teacher-weekly-digest',
  '0 4 * * 1',
  $cmd$ SELECT net.http_post(
    url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/teacher-weekly-digest',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', public.cron_service_key(),
      'Authorization', 'Bearer '||public.cron_service_key(),
      'x-internal-secret', public.internal_fn_secret()
    ),
    body := '{}'::jsonb
  ) $cmd$
);
