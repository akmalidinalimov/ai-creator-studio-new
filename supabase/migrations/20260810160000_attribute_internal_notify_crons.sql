-- Attribute the two per-minute internal notification crons via ops_net_post, so any future HTTP
-- failure names the caller in ops_http_failures (they were 'unattributed' when the intermittent
-- {"error":"forbidden"} 403s hit on 2026-08-10 — a stale cached internal_fn_secret in warm function
-- instances). ops_net_post just wraps net.http_post (identical send) and logs request_id -> sanitized
-- url + purpose. Companion to the function-side fix (re-fetch internal_fn_secret on mismatch, and
-- standardize broadcast-drainer onto the Vault RPC) that actually heals the 403 class.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'notify-homework-submission-every-minute') then
    perform cron.unschedule('notify-homework-submission-every-minute');
  end if;
  perform cron.schedule('notify-homework-submission-every-minute', '* * * * *', $cmd$
    select public.ops_net_post(
      'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/notify-homework-submission',
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      'notify-hw-submission')
  $cmd$);

  if exists (select 1 from cron.job where jobname = 'broadcast-drainer-every-minute') then
    perform cron.unschedule('broadcast-drainer-every-minute');
  end if;
  perform cron.schedule('broadcast-drainer-every-minute', '* * * * *', $cmd$
    select public.ops_net_post(
      'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/broadcast-drainer',
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      'broadcast-drainer')
  $cmd$);

  -- These two per-minute crons now log ~2,880 rows/day into ops_http_calls. Its pruner
  -- (prune_ops_http_observability, 3-day retention) was scheduled WEEKLY — tighten to daily so actual
  -- retention matches intent.
  if exists (select 1 from cron.job where jobname = 'prune-ops-http') then
    perform cron.unschedule('prune-ops-http');
  end if;
  perform cron.schedule('prune-ops-http', '30 3 * * *', $cmd$ select public.prune_ops_http_observability() $cmd$);
end $$;
