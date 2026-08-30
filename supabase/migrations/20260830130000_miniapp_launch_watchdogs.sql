-- Pre-global-launch watchdogs for the student Telegram Mini App (flag platform_settings.student_miniapp).
-- Two near-real-time detectors so a mass flip is NOT blind, mirroring username_link_stuck_watchdog
-- (20260826090000): SQL fn → app_settings alert-state (re-alert cooldown + recovery msg) → net.http_post
-- DM to ≤3 admins → idempotent cron. Both are no-ops until the flag is ON (they read admin_actions rows
-- that only exist once students actually use the Mini App), so applying this changes nothing today.
--
--   1. miniapp_entry_watchdog  — the auth/entry wall: a wave of miniapp_not_linked (lockouts) or
--      miniapp_mint_failed (the GoTrue thundering-herd symptom). Every 15 min.
--   2. xp_throughput_watchdog  — the SILENT UNDER-AWARD backstop: distinct students earning core XP
--      (lesson:/hw_submit:) in 24h collapsing vs the trailing-7-day baseline (normal ~20-29/day).
--      The only detector that catches mass under-crediting regardless of cause. Every 6h.
-- Thresholds are deliberately conservative (won't fire on normal variance) and easily tuned later.

-- ── 1. Mini App entry-failure watchdog ──────────────────────────────────────────────────────────
create or replace function public.miniapp_entry_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record;
  _not_linked int := 0; _mint_failed int := 0;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _t_not_linked int := 25;  -- >=25 DISTINCT telegram_ids walled in 60 min = resolution broken, not the odd dormant tap
  _t_mint_failed int := 5;  -- >=5 mint_failed in 60 min = GoTrue herd (a valid linked student can't get a session)
begin
  select count(distinct a.details->>'telegram_id') into _not_linked
  from public.admin_actions a
  where a.action = 'miniapp_not_linked' and a.created_at > now() - interval '60 minutes'
    and a.details->>'telegram_id' is not null;

  select count(*) into _mint_failed
  from public.admin_actions a
  where a.action = 'miniapp_mint_failed' and a.created_at > now() - interval '60 minutes';

  _breached := (_not_linked >= _t_not_linked) or (_mint_failed >= _t_mint_failed);

  select value into _state from public.app_settings where key = 'miniapp_entry_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > 7200000) then _should_alert := true; end if;  -- re-alert every 2h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Mini App kirish normallashdi: soʻnggi soatda ommaviy kirish xatosi yoʻq.'
        else '⚠️ Mini App kirish muammosi (soʻnggi 60 daqiqa): '
             || _not_linked || ' ta talaba tanilmadi (not_linked), '
             || _mint_failed || ' ta sessiya xatosi (mint_failed). Student Mini App ni oʻchirish kerak boʻlishi mumkin '
             || '(platform_settings.student_miniapp = {"enabled": false}).'
      end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value) values ('miniapp_entry_watchdog_state', jsonb_build_object(
    'alerting', _breached, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'not_linked_60m', _not_linked, 'mint_failed_60m', _mint_failed, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('not_linked', _not_linked, 'mint_failed', _mint_failed,
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.miniapp_entry_watchdog() from public, anon, authenticated;
grant execute on function public.miniapp_entry_watchdog() to service_role;

-- ── 2. XP throughput watchdog (silent under-award backstop) ──────────────────────────────────────
create or replace function public.xp_throughput_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record;
  _today int := 0; _baseline numeric := 0;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _min_baseline numeric := 12;   -- ignore low-traffic periods (avoids false alarms on quiet days)
  _drop_frac numeric := 0.5;     -- alarm only on a >50% collapse vs the 7-day daily average
begin
  -- Distinct students earning a CORE action (lesson completion / homework submission) in the last 24h.
  select count(distinct user_id) into _today
  from public.xp_events
  where created_at > now() - interval '24 hours'
    and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%');

  -- Baseline = average per-day distinct core-earners over the last 7 COMPLETE calendar days.
  select coalesce(avg(cnt), 0) into _baseline from (
    select date_trunc('day', created_at) d, count(distinct user_id) cnt
    from public.xp_events
    where created_at >= date_trunc('day', now()) - interval '7 days'
      and created_at <  date_trunc('day', now())
      and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%')
    group by 1
  ) t;

  _breached := (_baseline >= _min_baseline) and (_today < _baseline * _drop_frac);

  select value into _state from public.app_settings where key = 'xp_throughput_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > 43200000) then _should_alert := true; end if;  -- re-alert every 12h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ XP faolligi normallashdi: dars/vazifadan XP olayotgan talabalar soni tiklandi.'
        else '⚠️ XP faolligi keskin tushdi: soʻnggi 24 soatda dars/vazifadan XP olgan talaba atigi '
             || _today || ' ta (odatdagi kunlik oʻrtacha ~' || round(_baseline)::text || '). '
             || 'Mini App da video/vazifa hisobga olinmayotgan boʻlishi mumkin — tekshiring.'
      end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value) values ('xp_throughput_watchdog_state', jsonb_build_object(
    'alerting', _breached, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'today_earners', _today, 'baseline', round(_baseline, 1), 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('today', _today, 'baseline', round(_baseline, 1),
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.xp_throughput_watchdog() from public, anon, authenticated;
grant execute on function public.xp_throughput_watchdog() to service_role;

-- ── Deploy-time self-tests (never abort the migration; a failure is recorded, not raised) ─────────
do $$
begin
  perform public.miniapp_entry_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'miniapp_entry_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

do $$
begin
  perform public.xp_throughput_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'xp_throughput_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- ── Crons (idempotent; times chosen clear of the existing daily watchdogs 04:50-07:30) ────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'miniapp-entry-watchdog') then
    perform cron.unschedule('miniapp-entry-watchdog');
  end if;
  perform cron.schedule('miniapp-entry-watchdog', '*/15 * * * *', 'select public.miniapp_entry_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'miniapp-entry-watchdog', 'error', sqlerrm));
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'xp-throughput-watchdog') then
    perform cron.unschedule('xp-throughput-watchdog');
  end if;
  perform cron.schedule('xp-throughput-watchdog', '20 */6 * * *', 'select public.xp_throughput_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'xp-throughput-watchdog', 'error', sqlerrm));
end $$;
