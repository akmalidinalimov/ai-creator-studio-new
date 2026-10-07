-- Hourly reminders for unanswered «❓ Yordam» tickets (owner, 2026-10-07: "if I don't reply, resend it after an hour so
-- that I don't lose it").
--
-- The support-reminder edge function re-sends every open ticket to the admins every hour — the full ticket (words +
-- the screenshots / files / voice copied under it) with the same ✍️ / ✅ buttons; a Reply on the reminder answers the
-- ticket. Not between 23:00 and 08:00 Tashkent (the first morning run catches the night up).
--
-- This migration:
--   * platform_settings.support_reminders (the defaults, editable: enabled / every_min / quiet hours);
--   * the cron: every 10 min, calling the function ONLY when an open ticket is due (no HTTP otherwise).
-- support_tickets_watchdog (:27, 3 h / 12 h list) stays as it is — the independent backstop if this function stops.

insert into public.platform_settings (key, value)
values ('support_reminders', jsonb_build_object('enabled', true, 'every_min', 60, 'quiet_start_hour', 23, 'quiet_end_hour', 8))
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'support-reminder') then
    perform cron.unschedule('support-reminder');
  end if;
  perform cron.schedule('support-reminder', '*/10 * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/support-reminder', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'support-reminder', 60000)
   where coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_reminders'), true)
     and exists (
       select 1 from public.support_tickets t
        where t.status = 'open'
          and t.created_at < now() - make_interval(mins => coalesce(
                (select (value->>'every_min')::int from public.platform_settings where key = 'support_reminders'), 60))
          and (t.reminded_at is null or t.reminded_at < now() - make_interval(mins => coalesce(
                (select (value->>'every_min')::int from public.platform_settings where key = 'support_reminders'), 60)))) $cmd$);
end $$;
