-- Reliability-hardening P1-3 (recipient-class TREND) + P2-5b (classifier-drift counter). Extends
-- grade_delivery_watchdog (last defined in 20260825140000_grade_delivery_silence.sql) with two clauses:
--
--   P1-3: the other clauses EXCLUDE recipient_error (the ~70%-never-Started EXPECTED reach). But a bug
--   that makes EVERYONE fail as a recipient error (corrupted telegram_ids → "chat not found") hides
--   inside that exclusion while 100% of delivery silently stops. Watch the recipient-class volume
--   against its OWN trailing baseline — a floored spike turns the blind spot into a monitored trend.
--
--   P2-5b: a non-terminal failure whose error text is NOT a recognized benign transient is a GENUINELY
--   UNKNOWN string — usually a terminal error Telegram reworded so the classifier regex no longer
--   matches (then retried forever / miscounted). A wave of them surfaces the drift. (The TS classifier's
--   KNOWN strings are pinned by _shared/telegram-classify.test.ts; this catches what neither has seen.)
--
-- Reproduced verbatim from the silence version aside from the two new counters, their two thresholds,
-- two _breached terms, two alert lines, and four state/return keys. Every prior clause is byte-preserved.

-- Defensive re-seed (idempotent): #125 already seeded this; keep it so P1-3's self-test can't false-alarm
-- the silence clause even if applied against a DB where the heartbeat row is somehow absent.
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
  _recip_24h int; _recip_7d_avg numeric; _recip_spike boolean;
  _unclassified_24h int; _unclassified_spike boolean;
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
  _t_recip int := 15;         -- recipient-class failures / 24h floor before a spike is meaningful (~0 now)
  _t_unclassified int := 10;  -- unknown (non-terminal, non-benign-transient) error strings / 24h (~0 now)
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

  -- P1-3: recipient-class TREND. Watch the EXCLUDED recipient class against its own trailing baseline so
  -- a mass regression that dresses up as "expected reach" (e.g. corrupted telegram_ids → "chat not
  -- found" for everyone) can't hide. Floored + proportional: >15/24h AND, once there's history, >3× the
  -- trailing 7-day daily average. The floor guards the low-volume noise; the 3× auto-scales as we grow.
  select
    count(*) filter (where created_at > now() - interval '24 hours'),
    round(count(*) filter (where created_at > now() - interval '7 days') / 7.0, 2)
    into _recip_24h, _recip_7d_avg
  from public.admin_actions
  where action = 'telegram_send_failed'
    and coalesce((details->>'recipient_error')::boolean, false) = true;
  _recip_spike := (_recip_24h > _t_recip)
    and (_recip_7d_avg = 0 or _recip_24h::numeric > 3 * _recip_7d_avg);

  -- P2-5b: classifier-drift counter. terminal=false means the classifier saw neither a recipient nor a
  -- content match; if the error text is ALSO not a known benign transient (rate limit / 5xx / transport /
  -- timeout / flood) it's a genuinely UNKNOWN string — most likely a terminal error Telegram reworded
  -- past the regex. A wave (>10/24h; ~0 normally) means classification is drifting and the counts above
  -- can no longer be trusted. Surfaces the drift before it silently corrupts the other signals.
  -- NB: this benign-transient allowlist is a hand-maintained SQL mirror (nothing pins it — the TS test
  -- only covers recipient/content). It errs toward crying wolf (an unlisted transient inflates the count,
  -- bounded by the >10 floor + 24h cooldown), never toward silence. Extend it as real transients appear.
  select count(*) into _unclassified_24h from public.admin_actions
   where action = 'telegram_send_failed'
     and coalesce((details->>'terminal')::boolean, false) = false
     and coalesce(details->>'error', '') !~* '(too many requests|http_5|http_429|transport_error|internal server error|service unavailable|bad gateway|gateway timeout|timeout|timed out|retry after|flood)'
     and created_at > now() - interval '24 hours';
  _unclassified_spike := (_unclassified_24h > _t_unclassified);

  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg or _silence
                or _recip_spike or _unclassified_spike);

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
             case when _silence then E'\n' || '• ⚠ JIMLIK: 48 soatda ' || _scored_48h || ' ta baho qoʻyildi, lekin BIRORTA baho-karta DM yuborilmadi — yetkazish yoʻli oʻchgan boʻlishi mumkin' else '' end ||
             case when _recip_spike then E'\n' || '• ⚠ QABUL-QILUVCHI xatolari keskin oshdi: 24s ' || _recip_24h || ' ta (7-kun oʻrtacha ' || _recip_7d_avg || '/kun) — buzilish "kutilgan yetib bormaslik" ichida yashiringan boʻlishi mumkin' else '' end ||
             case when _unclassified_spike then E'\n' || '• ⚠ NOMAʼLUM Telegram xatolari: 24s ' || _unclassified_24h || ' ta tasniflanmagan — Telegram xato matnini oʻzgartirgan boʻlishi mumkin (telegram-classify)' else '' end || E'\n' ||
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
        'recip_24h', _recip_24h, 'recip_spike', _recip_spike,
        'unclassified_24h', _unclassified_24h, 'unclassified_spike', _unclassified_spike,
        'recovered', _recovered, 'at', now()));
    exception when others then null;
    end;
  end if;

  insert into public.app_settings (key, value) values ('grade_delivery_watchdog_state', jsonb_build_object(
    'alerting', _breached,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'silence', _silence, 'scored_48h', _scored_48h,
    'recip_24h', _recip_24h, 'recip_spike', _recip_spike,
    'unclassified_24h', _unclassified_24h, 'unclassified_spike', _unclassified_spike, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'silence', _silence, 'scored_48h', _scored_48h,
    'recip_24h', _recip_24h, 'recip_spike', _recip_spike,
    'unclassified_24h', _unclassified_24h, 'unclassified_spike', _unclassified_spike,
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.grade_delivery_watchdog() from public, anon, authenticated;
grant execute on function public.grade_delivery_watchdog() to service_role;

-- Deploy-time self-test — surfaces a runtime error at apply, not silently at the first cron run. Safe:
-- the heartbeat is seeded (above / by #125), and prod recipient+unclassified volumes are ~0/1, so no
-- clause fires at apply time.
do $$
begin
  perform public.grade_delivery_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'grade_delivery_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
