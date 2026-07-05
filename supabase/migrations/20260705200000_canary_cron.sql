-- Uptime canary: helper to count recent cron failures + a 15-min schedule that
-- invokes the canary edge function (which alerts admins on Telegram on failure).
create or replace function public.recent_cron_failures()
returns integer
language sql
stable
security definer
set search_path to 'public', 'cron'
as $$
  select count(*)::int
  from cron.job_run_details d
  where d.start_time > now() - interval '90 minutes'
    and d.status <> 'succeeded'
$$;

revoke execute on function public.recent_cron_failures() from public, anon, authenticated;

select cron.schedule(
  'canary-15min',
  '*/15 * * * *',
  $cmd$ SELECT net.http_post(
    url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/canary',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', public.cron_service_key(),
      'Authorization', 'Bearer '||public.cron_service_key(),
      'x-internal-secret', public.internal_fn_secret()
    ),
    body := '{}'::jsonb
  ) $cmd$
);
