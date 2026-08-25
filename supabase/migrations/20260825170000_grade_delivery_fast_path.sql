-- Reliability-hardening P2-4: fast-path detection. grade_delivery_watchdog runs DAILY (06:35 UTC), so
-- an acute delivery outage that starts right after a run isn't caught for ~24h. This adds an HOURLY
-- sibling that watches a SHORT (2h) window for an acute BURST of active failures — cutting detection
-- latency for a real outage from ~24h to ~1h.
--
-- Deliberately a separate, focused function rather than bloating (or re-cloning) the daily watchdog:
--   - It checks ONLY the acute, high-signal ACTIVE-failure counts (grade-card DM / media-unavailable /
--     non-recipient telegram_send_failed). The daily watchdog's slow-window clauses (silence over 48h,
--     recipient TREND / unclassified over 24h-7d) are inherently long-window and stay there.
--   - Its own state row (grade_delivery_fast_watchdog_state) → it's covered by the P0-2 liveness check
--     (#126) for free (the key matches '%_watchdog_state', and running hourly it's always < 25h fresh).
--   - Shorter 3h re-alert cooldown (vs the daily's 24h): this is the TIMELY leg, meant to fire fast and
--     recover fast, without spamming while an outage persists.

create or replace function public.grade_delivery_watchdog_fast()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record;
  _grade_fail int; _media_unavail int; _tg_fail int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _win interval := interval '2 hours';   -- acute window
  _t_grade int := 5;    -- acute burst floor: grade-card DM failures in 2h (daily is 5/24h — same count,
  _t_media int := 5;    -- acute burst floor: teacher media-unavailable in 2h    much shorter window =
                        -- a RATE spike)
  _t_tg    int := 10;   -- acute burst floor: non-recipient telegram_send_failed in 2h. Intentionally
                        -- HALF the daily's 20: tg_fail spans ALL senders and is naturally noisier, so
                        -- the acute per-hour bar is tighter than a simple 24h→2h scaling would give.
  _cooldown_ms bigint := 10800000;  -- 3h re-alert (daily uses 24h; this leg fires fast, recovers fast)
begin
  select count(*) into _grade_fail from public.admin_actions
   where action = 'grade_card_dm_failed'
     and coalesce((details->>'recipient_error')::boolean, false) = false
     and created_at > now() - _win;

  select count(*) into _media_unavail from public.admin_actions
   where action = 'grade_media_unavailable'
     and created_at > now() - _win;

  select count(*) into _tg_fail from public.admin_actions
   where action = 'telegram_send_failed'
     and coalesce((details->>'recipient_error')::boolean, false) = false
     and created_at > now() - _win;

  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg);

  select value into _state from public.app_settings where key = 'grade_delivery_fast_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > _cooldown_ms) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Baho yetkazish (tezkor kuzatuv): soʻnggi 2 soatda keskin xatolik yoʻq.'
        else '🚨 TEZKOR: baho/media yetkazishda keskin xatolik (soʻnggi 2 soat) — hozir tekshiring:' || E'\n' ||
             '• Baho DM yetmadi: ' || _grade_fail || E'\n' ||
             '• Ustozga media koʻrinmadi: ' || _media_unavail || E'\n' ||
             '• Telegram joʻnatish xatosi: ' || _tg_fail || E'\n' ||
             'admin_actions ni koʻring (kunlik kuzatuv batafsil sabab beradi).'
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

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'grade_delivery_fast_watchdog_alert', jsonb_build_object(
        'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
        'window', '2h', 'recovered', _recovered, 'at', now()));
    exception when others then null;
    end;
  end if;

  insert into public.app_settings (key, value) values ('grade_delivery_fast_watchdog_state', jsonb_build_object(
    'alerting', _breached,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.grade_delivery_watchdog_fast() from public, anon, authenticated;
grant execute on function public.grade_delivery_watchdog_fast() to service_role;

-- Deploy-time self-test — surfaces a runtime error at apply, not silently at the first cron run. Safe
-- on go-live: the 2h-window counts are ~0 in prod, so no clause breaches → no alarm fired at apply.
do $$
begin
  perform public.grade_delivery_watchdog_fast();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'grade_delivery_fast_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- Cron — hourly at :37. Deliberately NOT a multiple of 5: dodges the */5 (lesson-media-guard) and */10
-- (ops-http-sweep) families AND the :25/:40/:45/:55 hourly jobs, minimizing pg_cron concurrency
-- contention (default cron.max_running_jobs) at the fire minute. Idempotent unschedule-then-schedule.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'grade-delivery-watchdog-fast') then
    perform cron.unschedule('grade-delivery-watchdog-fast');
  end if;
  perform cron.schedule('grade-delivery-watchdog-fast', '37 * * * *', 'select public.grade_delivery_watchdog_fast()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'grade-delivery-watchdog-fast', 'error', sqlerrm));
end $$;
