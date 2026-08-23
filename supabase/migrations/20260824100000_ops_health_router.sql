-- Health router — routes real, CODE-FIXABLE anomalies to the ops-investigate agent (Phase 4 dispatch).
--
-- The watchdogs each DM admins when they alarm; the daily digest (ops_daily_digest) already summarizes
-- system health + reports what the agent did. The missing piece is the LOOP-CLOSER: when a watchdog
-- alarms on something a code change could fix, automatically ask the ops-investigate agent to
-- investigate + propose a fix PR (a human still approves the merge via the Telegram tap). This adds it.
--
-- Safety / gating:
--  * DORMANT unless platform_settings.ops_agent = {enabled:true, auto_dispatch:true} AND the OPS_GITHUB_PAT
--    Vault secret exists (ops_github_pat() → NULL ⇒ no-op). Kill-switch: flip auto_dispatch/enabled false.
--  * Rate-limited to one auto-dispatch per min_dispatch_interval_min (default 360 = 6h).
--  * The ops-investigate workflow itself dedupes (skips if an ops/* PR is already open) and a human
--    still gates the merge — so a dispatch only STARTS an investigation, it never ships anything.
--  * Only dispatches on code-fixable classes (XP integrity, client-error spike, watch-gate regression,
--    cron failures) — never on external issues (reputation, network) that code can't fix.

-- 1. Dispatch primitive.
create or replace function public.ops_maybe_dispatch_agent(_reason text, _problem text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  _cfg jsonb; _enabled boolean; _auto boolean; _interval_min int;
  _pat text; _last_ms bigint; _now_ms bigint := (extract(epoch from now())*1000)::bigint;
begin
  select value into _cfg from platform_settings where key='ops_agent';
  _enabled := coalesce((_cfg->>'enabled')::boolean, false);
  _auto := coalesce((_cfg->>'auto_dispatch')::boolean, false);
  _interval_min := coalesce((_cfg->>'min_dispatch_interval_min')::int, 360);
  if not (_enabled and _auto) then return false; end if;

  select coalesce((value->>'last_dispatch_ms')::bigint, 0) into _last_ms
    from app_settings where key='ops_agent_dispatch_state';
  if _last_ms > 0 and (_now_ms - _last_ms) < _interval_min * 60000 then return false; end if;  -- rate-limit

  _pat := public.ops_github_pat();
  if _pat is null or _pat = '' then return false; end if;  -- dormant until the PAT secret exists

  begin
    perform net.http_post(
      url := 'https://api.github.com/repos/akmalidinalimov/ai-creator-studio-new/actions/workflows/ops-investigate.yml/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || _pat,
        'Accept', 'application/vnd.github+json',
        'X-GitHub-Api-Version', '2022-11-28',
        'User-Agent', 'ai-creator-ops-router',
        'Content-Type', 'application/json'),
      body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('problem', left(_problem, 1500))));
  exception when others then
    return false;  -- queueing failed; don't advance the clock
  end;

  insert into app_settings (key, value) values ('ops_agent_dispatch_state',
    jsonb_build_object('last_dispatch_ms', _now_ms, 'last_reason', _reason, 'at', now()))
  on conflict (key) do update set value = excluded.value;
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'ops_agent_dispatched', jsonb_build_object('reason', _reason, 'problem', left(_problem, 500), 'at', now()));
  exception when others then null; end;
  return true;
end;
$function$;
revoke execute on function public.ops_maybe_dispatch_agent(text, text) from public, anon, authenticated;
grant execute on function public.ops_maybe_dispatch_agent(text, text) to service_role;

-- 2. Router — checks the code-fixable anomaly signals and dispatches the first one found (the primitive
--    rate-limits further). Reads each watchdog's own alerting state (single source of truth).
create or replace function public.ops_health_router()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _reason text := null; _problem text := null; _dispatched boolean := false;
  _xp jsonb; _client jsonb; _wg jsonb; _cron_fail int;
begin
  select value into _xp from app_settings where key='xp_integrity_watchdog_state';
  select value into _client from app_settings where key='client_error_watchdog_state';
  select value into _wg from app_settings where key='watch_gate_watchdog_state';
  select count(*) into _cron_fail from cron.job_run_details where status='failed' and start_time > now() - interval '2 hours';

  if coalesce((_xp->>'alerting')::boolean, false) then
    _reason := 'xp_integrity';
    _problem := 'XP-award integrity watchdog is alarming (admin_actions action=xp_integrity_report): recent_unjustified=' ||
      coalesce(_xp->>'recent_unjustified','?') || ', amount_mismatch=' || coalesce(_xp->>'amount_mismatch','?') ||
      ', drift=' || coalesce(_xp->>'drift','?') || '. Investigate which award reason is over/mis-crediting and propose a fix. Do NOT change any points without confirming the root cause.';
  elsif coalesce((_client->>'alerting')::boolean, false) then
    _reason := 'client_errors';
    _problem := 'Client-error watchdog is alarming (admin_actions action=client_error_report): a spike of browser-side failures (chunk_load / render_crash / backend_unreachable / video_error). Investigate the top event_type + route in client_error_events and propose a fix.';
  elsif coalesce((_wg->>'alerting')::boolean, false) then
    _reason := 'watch_gate';
    _problem := 'Watch-gate watchdog is alarming: videos marked watched with <20% watch time (bad_24h=' || coalesce(_wg->>'bad_24h','?') ||
      '). The completion gate (src/lib/watchGate.ts) may have regressed. Investigate + propose a fix.';
  elsif _cron_fail > 3 then
    _reason := 'cron_failures';
    _problem := _cron_fail || ' cron job runs failed in the last 2h (see cron.job_run_details). Investigate which job + why and propose a fix.';
  end if;

  if _reason is not null then
    _dispatched := public.ops_maybe_dispatch_agent(_reason, _problem);
  end if;
  return jsonb_build_object('anomaly', _reason, 'dispatched', _dispatched, 'checked_at', now());
end;
$function$;
revoke execute on function public.ops_health_router() from public, anon, authenticated;
grant execute on function public.ops_health_router() to service_role;

-- 3. Enable auto-dispatch (owner-requested). Kill-switch: set auto_dispatch=false (or enabled=false).
update public.platform_settings
set value = coalesce(value, '{}'::jsonb) || jsonb_build_object('auto_dispatch', true)
where key = 'ops_agent';

-- 4. Cron — hourly at :40 (offset from the watchdogs so it sees their fresh states).
do $$
begin
  if exists (select 1 from cron.job where jobname='ops-health-router') then perform cron.unschedule('ops-health-router'); end if;
  perform cron.schedule('ops-health-router', '40 * * * *', 'select public.ops_health_router()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'ops-health-router', 'error', sqlerrm));
end $$;
