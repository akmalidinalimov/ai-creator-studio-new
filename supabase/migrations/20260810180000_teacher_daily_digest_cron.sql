-- Schedule the daily teacher digest at 21:00 Asia/Tashkent (= 16:00 UTC; Uzbekistan is a fixed UTC+5,
-- no DST). Invokes the teacher-daily-digest edge function via the attributed ops_net_post wrapper so
-- any failure is named in ops_http_failures. The function is x-internal-secret gated (rotation-safe)
-- and emits DB-visible signals: notifications_log (per teacher) + admin_actions
-- ('teacher_daily_report_run' / '_failed'). Recipients: every teacher with a telegram_id; an aggregate
-- summary is DM'd to admins for accountability. p_timeout_ms is raised to 30s because the function
-- loops sendMessage over every teacher + admins and could exceed pg_net's 5s default (a spurious
-- timed_out row otherwise).

do $$
begin
  if exists (select 1 from cron.job where jobname = 'teacher-daily-digest') then
    perform cron.unschedule('teacher-daily-digest');
  end if;
  perform cron.schedule('teacher-daily-digest', '0 16 * * *', $cmd$
    select public.ops_net_post(
      'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/teacher-daily-digest',
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      'teacher-daily-digest', 30000)
  $cmd$);
end $$;
