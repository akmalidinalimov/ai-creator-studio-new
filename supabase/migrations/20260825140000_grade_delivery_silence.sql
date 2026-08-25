-- Reliability-hardening P0-1: add SILENCE detection to grade_delivery_watchdog (the "dog that didn't
-- bark"). A failure-COUNTER is blind to the worst case — grading happening but grade-card DMs no longer
-- ATTEMPTED (a bug returns before the send) produces ZERO failure rows and reads as "healthy". The
-- webhook now stamps a single-row heartbeat (app_settings.grade_card_dm_heartbeat) on every DELIVERED
-- grade card; this clause alarms when homework was scored in the last 48h but that heartbeat is stale —
-- i.e., the delivery path emitted nothing at all. Additive; every prior clause is byte-preserved.

-- Bootstrap the heartbeat to NOW so the deploy self-test (and the first 48h, before the webhook that
-- writes it has redeployed + sent a card) can't false-alarm. `do nothing` never clobbers a real stamp.
insert into public.app_settings (key, value)
values ('grade_card_dm_heartbeat', jsonb_build_object('last_sent_at', now()))
on conflict (key) do nothing;

create or replace function public.grade_delivery_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record;
  _grade_fail int; _media_unavail int; _tg_fail int;
  _scored_48h int; _hb jsonb; _hb_stale boolean; _silence boolean;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _t_grade int := 5;    -- fixable grade-card DM failures / 24h (excl. expected recipient misses)
  _t_media int := 5;    -- teacher opened grading but no media delivered / 24h
  _t_tg    int := 20;   -- shared sendTelegram transient/content non-deliveries / 24h (across all senders)
  -- min gradings-with-telegram in 48h before "zero grade-card DMs" is meaningful (not a quiet period).
  -- Tuned to real volume (~9/48h): 5 = there was genuine grading activity yet the delivery path emitted
  -- nothing for 48h. The bot is the primary grading tool, so 5+ gradings almost always includes bot
  -- gradings that should have refreshed the heartbeat.
  _t_scored int := 5;
begin
  select count(*) into _grade_fail from public.admin_actions
   where action = 'grade_card_dm_failed'
     and coalesce((details->>'recipient_error')::boolean, false) = false
     and created_at > now() - interval '24 hours';

  select count(*) into _media_unavail from public.admin_actions
   where action = 'grade_media_unavailable'
     and created_at > now() - interval '24 hours';

  select count(*) into _tg_fail from public.admin_actions
   where action = 'telegram_send_failed'
     and coalesce((details->>'recipient_error')::boolean, false) = false
     and created_at > now() - interval '24 hours';

  -- SILENCE: grading is happening (scored submissions whose student has a telegram_id) but the grade-card
  -- delivery heartbeat is stale (no successful card in 48h) => the send path may be dead / never running.
  -- ACCEPTED v1 trade-off: _scored_48h counts students who HAVE a telegram_id, not whether they're
  -- reachable (never pressed Start ~ 70%, unknowable at query time). A single successful card ANYWHERE on
  -- the platform in 48h keeps the heartbeat fresh, so the only false-alarm is a 48h window whose 5+
  -- gradings are ALL to never-Started students — rare (bot-graded students necessarily started the bot),
  -- rate-limited (once/24h) and self-recovering. A later pass could require a baseline success rate.
  select count(*) into _scored_48h from public.homework_submissions hs
    join public.profiles p on p.id = hs.user_id
   where hs.scored_at > now() - interval '48 hours'
     and p.telegram_id is not null;
  select value into _hb from public.app_settings where key = 'grade_card_dm_heartbeat';
  _hb_stale := (_hb is null)
    or (coalesce((_hb->>'last_sent_at')::timestamptz, 'epoch'::timestamptz) < now() - interval '48 hours');
  _silence := (_scored_48h > _t_scored) and _hb_stale;

  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg or _silence);

  select value into _state from public.app_settings where key = 'grade_delivery_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Baho/media yetkazish normallashdi: soʻnggi 24 soatda yetkazib boʻlmagan baho DM / koʻrinmagan media anomaliyasi yoʻq.'
        else '⚠️ Baho/media yetkazish anomaliyasi (soʻnggi 24 soat) — talaba/ustoz kerakli narsani olmagan boʻlishi mumkin:' || E'\n' ||
             '• Baho DM yetmadi (tuzatiladigan): ' || _grade_fail || E'\n' ||
             '• Ustozga media koʻrinmadi: ' || _media_unavail || E'\n' ||
             '• Telegram joʻnatish xatosi (tuzatiladigan): ' || _tg_fail ||
             case when _silence then E'\n' || '• ⚠ JIMLIK: 48 soatda ' || _scored_48h || ' ta baho qoʻyildi, lekin BIRORTA baho-karta DM yuborilmadi — yetkazish yoʻli oʻchgan boʻlishi mumkin' else '' end || E'\n' ||
             'admin_actions (grade_card_dm_failed / grade_media_unavailable / telegram_send_failed) ni koʻring.'
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
      values (null, 'grade_delivery_watchdog_alert', jsonb_build_object(
        'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
        'silence', _silence, 'scored_48h', _scored_48h,
        'recovered', _recovered, 'at', now()));
    exception when others then null;
    end;
  end if;

  insert into public.app_settings (key, value) values ('grade_delivery_watchdog_state', jsonb_build_object(
    'alerting', _breached,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'silence', _silence, 'scored_48h', _scored_48h, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'silence', _silence, 'scored_48h', _scored_48h,
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.grade_delivery_watchdog() from public, anon, authenticated;
grant execute on function public.grade_delivery_watchdog() to service_role;

-- Deploy-time self-test — surfaces a runtime error at apply, not silently at the first cron run. Safe:
-- the heartbeat was just seeded to now(), so _hb_stale is false and the silence clause cannot fire here.
do $$
begin
  perform public.grade_delivery_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'grade_delivery_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
