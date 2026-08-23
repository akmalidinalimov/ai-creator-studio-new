-- Health router — routes real, CODE-FIXABLE anomalies to the ops-investigate agent (Phase 4 dispatch).
--
-- The watchdogs each DM admins when they alarm; the daily digest (ops_daily_digest) already summarizes
-- system health + reports what the agent did. The missing piece is the LOOP-CLOSER: when a watchdog
-- alarms on something a code change could fix, automatically ask the ops-investigate agent to
-- investigate + propose a fix PR (a human still approves the merge via the Telegram tap).
--
-- GO-LIVE NOTE: platform_settings.ops_agent.enabled has been true since Phase 1, and step 3 below sets
-- auto_dispatch=true (owner-requested), so this router is LIVE on merge. Verified before labeling that
-- all three watchdog states are currently clean (alerting=false) and there is no recent cron-failure
-- burst, so the first hourly tick cannot surprise-dispatch — it will only fire on a genuinely NEW
-- code-fixable anomaly, which is the intent. Kill-switch: set ops_agent.auto_dispatch (or enabled) false.
--
-- Safety:
--  * DORMANT unless ops_agent.{enabled,auto_dispatch}=true AND ops_github_pat() (Vault) is set.
--  * Rate-limited to one dispatch per min_dispatch_interval_min (default 360 = 6h).
--  * The ops-investigate workflow dedupes (skips if an ops/* PR is open) and a human gates the merge —
--    a dispatch only STARTS an investigation, it never ships anything.
--  * Only code-fixable classes (XP integrity, client-error spike, watch-gate regression, cron failures).

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
    -- Via ops_net_post so a failed dispatch is attributable in the HTTP-failure observability pipeline.
    perform public.ops_net_post(
      'https://api.github.com/repos/akmalidinalimov/ai-creator-studio-new/actions/workflows/ops-investigate.yml/dispatches',
      jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('problem', left(_problem, 1500))),
      jsonb_build_object(
        'Authorization', 'Bearer ' || _pat,
        'Accept', 'application/vnd.github+json',
        'X-GitHub-Api-Version', '2022-11-28',
        'User-Agent', 'ai-creator-ops-router',
        'Content-Type', 'application/json'),
      'ops-github-dispatch');
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

-- 2. Router — checks the code-fixable anomaly signals and dispatches the first found (the primitive
--    rate-limits further). Reads each watchdog's own alerting state (single source of truth).
--    Whole body is crash-guarded so a failed run leaves a DB-visible diagnostic (like the watchdogs).
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
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ops_health_router_crashed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
    return jsonb_build_object('crashed', true, 'error', sqlerrm, 'checked_at', now());
  end;
end;
$function$;
revoke execute on function public.ops_health_router() from public, anon, authenticated;
grant execute on function public.ops_health_router() to service_role;

-- 3. Enable auto-dispatch (owner-requested). Insert-on-conflict merge preserves enabled +
--    min_dispatch_interval_min. Kill-switch: set auto_dispatch=false (or enabled=false).
insert into public.platform_settings (key, value)
values ('ops_agent', jsonb_build_object('auto_dispatch', true))
on conflict (key) do update
  set value = coalesce(public.platform_settings.value, '{}'::jsonb) || jsonb_build_object('auto_dispatch', true);

-- 4. Cron — hourly at :40 (offset from the watchdogs so it sees their fresh states).
do $$
begin
  if exists (select 1 from cron.job where jobname='ops-health-router') then perform cron.unschedule('ops-health-router'); end if;
  perform cron.schedule('ops-health-router', '40 * * * *', 'select public.ops_health_router()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'ops-health-router', 'error', sqlerrm));
end $$;
