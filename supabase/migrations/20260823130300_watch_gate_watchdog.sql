-- Detector for the watch-gate class (incident doctrine step 5). The forward-fix (PR #105) should make
-- new false completions ~0; a spike means the completion gate (src/lib/watchGate.ts) regressed or a new
-- bypass appeared. Complements xp_award_integrity_watchdog (whole-ledger auditor); this is the fast,
-- specific signal on false *completions*. Modeled on enrollment_watchdog.

create or replace function public.watch_gate_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record; _bad int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _msg text;
  -- Tunable: how many <20%-watched "completions" in 24h count as an anomaly. Above the transition
  -- trickle (students on a stale cached build still using the old gate until they reload).
  _threshold int := 8;
begin
  select count(*) into _bad
  from public.lesson_progress lp
  join public.lessons l on l.id = lp.lesson_id
  where lp.completed_at is not null
    and lp.completed_at > now() - interval '24 hours'
    and l.video_provider = 'bunny'
    and coalesce(l.provider_video_id, '') <> ''
    and greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0)) >= 90
    and coalesce(lp.max_position_seconds, 0)
        < 0.2 * greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0));

  select value into _state from app_settings where key = 'watch_gate_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _bad > _threshold then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Watch-gate normallashdi: soʻnggi 24 soatda koʻrilmagan videolar "tugatildi" deb belgilanmayapti.'
        else '⚠️ Watch-gate anomaliyasi: soʻnggi 24 soatda ' || _bad ||
             ' ta video <20% koʻrilgan holda "tugatildi" deb belgilangan. Completion gate (watchGate.ts) buzilgan boʻlishi mumkin.'
      end;
      for _admin in
        select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
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

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'watch_gate_watchdog_alert',
              jsonb_build_object('bad_24h', _bad, 'threshold', _threshold, 'recovered', _recovered, 'at', now()));
    exception when others then null;
    end;
  end if;

  insert into app_settings (key, value) values ('watch_gate_watchdog_state', jsonb_build_object(
    'alerting', (_bad > _threshold),
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'bad_24h', _bad, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('bad_24h', _bad, 'threshold', _threshold, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.watch_gate_watchdog() from public, anon, authenticated;
grant execute on function public.watch_gate_watchdog() to service_role;

-- Deploy-time self-test (surfaces any runtime error at deploy, not silently at the first cron run).
do $$
begin
  perform public.watch_gate_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'watch_gate_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'watch-gate-watchdog') then
    perform cron.unschedule('watch-gate-watchdog');
  end if;
  perform cron.schedule('watch-gate-watchdog', '15 6 * * *', 'select public.watch_gate_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'watch-gate-watchdog', 'error', sqlerrm));
end $$;
