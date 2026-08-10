-- Track C1 — HTTP-call observability: capture + classify + alert engine.
-- Depends on 20260810130000 (ops_http_failures, ops_http_calls, ops_net_post, ops_sanitize_url, ops_redact_secrets).
--
-- Pipeline:  ops_http_failure_sweep()  (cron */10) captures + CLASSIFIES failed net._http_response
--            rows into ops_http_failures before pg_net's ~6h GC erases them.
--            ops_http_failure_watchdog() (cron */30) alerts admins on REAL faults only, per-signature
--            deduped; expected Telegram noise ("bot was blocked" = the ~70% who never Started) is
--            suppressed. ops_http_health() feeds the daily digest + the external GitHub verifier.
-- Classification is done AT CAPTURE (once per row) so health/watchdog just read it.
-- Design/classifier rules: docs/superpowers/specs/2026-08-10-http-call-observability-design.md §6.
-- Classification & redaction expressions validated read-only on prod 2026-08-10.

-- ── config + mutable state (one platform_settings row) ────────────────────────────────────────────
insert into platform_settings (key, value, updated_at)
values ('ops_http_watchdog', jsonb_build_object(
    'enabled',           true,
    'cooldown_hours',     3,      -- re-alert the same signature at most this often
    'window_min',        45,      -- watchdog look-back (> its 30m period, so runs overlap)
    'timeout_threshold', 20,      -- alert only if timeouts in the window exceed this (bursts are benign)
    'tg_expected_regex', 'bot was blocked|can''t initiate|chat not found|user is deactivated|bot was kicked|not enough rights|group chat was upgraded|bot was blocked by the user',
    'last_sweep_at',      null,
    'alert_state',        '{}'::jsonb
  ), now())
on conflict (key) do nothing;

-- ── capture + classify (cron */10) ────────────────────────────────────────────────────────────────
create or replace function public.ops_http_failure_sweep()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _watermark timestamptz;
  _tg_regex  text;
  _n int;
begin
  select coalesce((value->>'last_sweep_at')::timestamptz, now() - interval '6 hours'),
         coalesce(nullif(value->>'tg_expected_regex', ''), 'bot was blocked')   -- nullif: empty regex would match ALL
    into _watermark, _tg_regex
    from platform_settings where key = 'ops_http_watchdog';
  _watermark := coalesce(_watermark, now() - interval '6 hours');

  with src as (
    select r.id, r.status_code, r.timed_out, r.error_msg, r.content, r.created
    from net._http_response r
    where r.created > _watermark
      and (r.status_code >= 400 or r.status_code is null or r.timed_out or r.error_msg is not null)
  ), ins as (
    insert into public.ops_http_failures
      (response_id, status_code, timed_out, error_msg, content_snip, url, purpose, classification, occurred_at)
    select
      s.id, s.status_code, coalesce(s.timed_out, false),
      left(public.ops_redact_secrets(s.error_msg), 240),   -- redact: some transport errors echo the full (token-bearing) URL
      left(public.ops_redact_secrets(s.content),  240),
      c.url, c.purpose,
      case
        when coalesce(s.timed_out, false)                        then 'timeout'   -- congestion-shaped, rate-based
        when s.status_code is null and s.error_msg is not null   then 'real'       -- DNS/conn/TLS transport error, not a timeout
        when s.status_code is null                               then 'timeout'
        when s.status_code between 500 and 599                   then 'real'
        when s.status_code = 401                                 then 'real'
        when s.status_code >= 400 and coalesce(s.content, '') ~* _tg_regex
             and (c.url ~* 'api\.telegram\.org' or coalesce(s.content, '') ~* '"ok"\s*:\s*false')
                                                                 then 'expected'   -- genuine Telegram unreachable-user noise
        when s.status_code >= 400                                then 'real'
        else 'unknown'
      end,
      s.created
    from src s
    left join public.ops_http_calls c on c.request_id = s.id
    on conflict (response_id) do nothing
    returning 1
  )
  select count(*) into _n from ins;

  -- advance the watermark to now() with a 2-min overlap; capture is idempotent (response_id PK)
  update platform_settings
     set value = jsonb_set(value, '{last_sweep_at}', to_jsonb((now() - interval '2 minutes')::text)),
         updated_at = now()
   where key = 'ops_http_watchdog';

  if _n > 0 then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ops_http_failures_captured', jsonb_build_object('n', _n, 'at', now()));
    exception when others then null; end;
  end if;
  return _n;
end
$$;

-- ── classify + alert (cron */30) ──────────────────────────────────────────────────────────────────
create or replace function public.ops_http_failure_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _cfg jsonb; _cooldown interval; _window interval; _timeout_threshold int;
  _state jsonb; _new_state jsonb; _lines text := ''; _sig text; _last timestamptz;
  _now timestamptz := now(); _tok text; _admin record; _rec record; _timeouts int; _sent int := 0;
begin
  select value into _cfg from platform_settings where key = 'ops_http_watchdog';
  if not coalesce((_cfg->>'enabled')::bool, true) then
    return jsonb_build_object('skipped', 'disabled');
  end if;
  _cooldown          := make_interval(hours => coalesce((_cfg->>'cooldown_hours')::int, 3));
  _window            := make_interval(mins  => coalesce((_cfg->>'window_min')::int, 45));
  _timeout_threshold := coalesce((_cfg->>'timeout_threshold')::int, 20);
  _state             := coalesce(_cfg->'alert_state', '{}'::jsonb);
  _new_state         := _state;

  -- real faults grouped by signature (attributed caller + status)
  for _rec in
    select coalesce(purpose, url, 'unattributed') as who, status_code, count(*) as n
    from public.ops_http_failures
    where classification = 'real' and occurred_at > _now - _window
    group by 1, 2
  loop
    _sig  := 'real:' || _rec.who || ':' || coalesce(_rec.status_code::text, 'ERR');
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• ' || coalesce(_rec.status_code::text, 'ERR') || ' × ' || _rec.n
                            || '  ' || left(_rec.who, 60);
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end loop;

  -- timeout burst (rate-based, one signature)
  select count(*) into _timeouts
    from public.ops_http_failures
    where classification = 'timeout' and occurred_at > _now - _window;
  if _timeouts > _timeout_threshold then
    _sig  := 'timeout-burst';
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• ⏱ Timeouts: ' || _timeouts || ' in '
                            || coalesce(_cfg->>'window_min', '45') || 'm (pg_net congestion?)';
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end if;

  update platform_settings
     set value = jsonb_set(value, '{alert_state}', _new_state), updated_at = now()
   where key = 'ops_http_watchdog';

  if _lines = '' then
    return jsonb_build_object('alerted', 0, 'timeouts_window', _timeouts);
  end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then
    return jsonb_build_object('alerted', 0, 'note', 'no_token');
  end if;

  for _admin in
    select distinct p.telegram_id from profiles p
    join user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
    where p.telegram_id is not null
    limit 3
  loop
    begin
      -- send via ops_net_post so the alert channel itself is observed on the next sweep
      perform public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        jsonb_build_object('chat_id', _admin.telegram_id,
          'text', '⚠️ HTTP faults (last ' || coalesce(_cfg->>'window_min', '45') || 'm):' || _lines
                  || E'\n\nRunbook: RUNBOOK.md · detail: ops_http_failures order by occurred_at desc'),
        jsonb_build_object('Content-Type', 'application/json'),
        'ops-http-alert'
      );
      _sent := _sent + 1;
    exception when others then null; end;
  end loop;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'ops_http_watchdog_alert', jsonb_build_object('lines', _lines, 'sent', _sent, 'at', _now));
  exception when others then null; end;

  return jsonb_build_object('alerted', _sent, 'lines', _lines);
end
$$;

-- ── health signal (for ops_daily_digest + external verifier) ──────────────────────────────────────
create or replace function public.ops_http_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare _cfg jsonb; _last_sweep timestamptz;
begin
  select value into _cfg from platform_settings where key = 'ops_http_watchdog';
  _last_sweep := nullif(_cfg->>'last_sweep_at', '')::timestamptz;
  return jsonb_build_object(
    'watchdog_enabled',        coalesce((_cfg->>'enabled')::bool, true),
    'last_sweep_at',           _last_sweep,
    'sweep_stale_min',         case when _last_sweep is null then null
                                    else round(extract(epoch from (now() - _last_sweep)) / 60.0)::int end,
    'real_faults_1h',          (select count(*) from public.ops_http_failures
                                  where classification = 'real'    and occurred_at > now() - interval '1 hour'),
    'real_faults_24h',         (select count(*) from public.ops_http_failures
                                  where classification = 'real'    and occurred_at > now() - interval '24 hours'),
    'timeouts_1h',             (select count(*) from public.ops_http_failures
                                  where classification = 'timeout' and occurred_at > now() - interval '1 hour'),
    'expected_suppressed_24h', (select count(*) from public.ops_http_failures
                                  where classification = 'expected' and occurred_at > now() - interval '24 hours'),
    'open_real_signatures',    (select coalesce(jsonb_agg(distinct coalesce(purpose, url, 'unattributed')), '[]'::jsonb)
                                  from public.ops_http_failures
                                  where classification = 'real' and occurred_at > now() - interval '3 hours')
  );
end
$$;

-- ── retention ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.prune_ops_http_observability()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.ops_http_failures where captured_at < now() - interval '30 days';
  delete from public.ops_http_calls    where created_at  < now() - interval '3 days';
end
$$;

revoke execute on function public.ops_http_failure_sweep()          from public, anon, authenticated;
revoke execute on function public.ops_http_failure_watchdog()       from public, anon, authenticated;
revoke execute on function public.ops_http_health()                 from public, anon, authenticated;
revoke execute on function public.prune_ops_http_observability()    from public, anon, authenticated;

-- ── schedule + prime ──────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ops-http-sweep')     then perform cron.unschedule('ops-http-sweep');     end if;
  if exists (select 1 from cron.job where jobname = 'ops-http-watchdog')  then perform cron.unschedule('ops-http-watchdog');  end if;
  if exists (select 1 from cron.job where jobname = 'prune-ops-http')     then perform cron.unschedule('prune-ops-http');     end if;

  perform cron.schedule('ops-http-sweep',    '*/10 * * * *', $cmd$ select public.ops_http_failure_sweep()       $cmd$);
  perform cron.schedule('ops-http-watchdog', '*/30 * * * *', $cmd$ select public.ops_http_failure_watchdog()    $cmd$);
  perform cron.schedule('prune-ops-http',    '30 3 * * 0',   $cmd$ select public.prune_ops_http_observability() $cmd$);

  -- prime once so the current backlog (incl. the live 403s) is captured immediately for verification;
  -- WRAPPED so a failure here can never roll back the tables/functions/crons/config created above
  -- (the whole file applies as one transaction via the Management API).
  begin
    perform public.ops_http_failure_sweep();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ops_http_failure_sweep_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
