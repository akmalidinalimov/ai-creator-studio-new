-- Detector for the "student/teacher didn't get what they should" delivery class (incident doctrine
-- step 5), closing the loop on the reliability + teacher-media work:
--   • grade_card_dm_failed      (#119) — a graded student's score DM didn't deliver.
--   • grade_media_unavailable   (#120) — a teacher opened grading but no submitted media re-sent.
--   • telegram_send_failed      (#116/#117 sendTelegram) — a shared-sender non-delivery.
-- Those rows are already DB-visible in admin_actions; this makes a SPIKE of them ALERT the admins
-- proactively (a daily Telegram DM) instead of sitting unread. Modeled exactly on watch_gate_watchdog.
--
-- Member-forgiveness / no false alarms: recipient-class non-delivery (~70% of students never pressed
-- Start on the bot) is EXPECTED reach, NOT a fault — every count below EXCLUDES recipient_error=true and
-- alarms only on transient/content (fixable) failures. grade_media_unavailable has no recipient class:
-- the teacher IS reachable (they're grading), so any occurrence is a genuine "couldn't see the homework".

create or replace function public.grade_delivery_watchdog()
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
  -- Tunables: counts per 24h that constitute an anomaly (above the normal transient trickle).
  _t_grade int := 5;    -- fixable grade-card DM failures (excl. expected recipient misses)
  _t_media int := 5;    -- teacher opened grading but no media delivered
  _t_tg    int := 20;   -- shared sendTelegram transient/content non-deliveries across ALL senders
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

  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg);

  select value into _state from public.app_settings where key = 'grade_delivery_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  -- Re-alert at most once/24h while breached; announce recovery once when it clears.
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
             '• Telegram joʻnatish xatosi (tuzatiladigan): ' || _tg_fail || E'\n' ||
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
        'recovered', _recovered, 'at', now()));
    exception when others then null;
    end;
  end if;

  insert into public.app_settings (key, value) values ('grade_delivery_watchdog_state', jsonb_build_object(
    'alerting', _breached,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('grade_fail', _grade_fail, 'media_unavail', _media_unavail, 'tg_fail', _tg_fail,
    'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.grade_delivery_watchdog() from public, anon, authenticated;
grant execute on function public.grade_delivery_watchdog() to service_role;

-- Deploy-time self-test — surfaces any runtime error at apply, not silently at the first cron run.
-- Safe on go-live: the three signals only just started emitting (deployed 2026-08-25), so the 24h
-- counts are ~0 and this first run cannot surprise-alert.
do $$
begin
  perform public.grade_delivery_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'grade_delivery_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- Cron — daily 06:35 UTC (~11:35 Tashkent), offset from watch-gate-watchdog (06:15) so their runs don't overlap.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'grade-delivery-watchdog') then
    perform cron.unschedule('grade-delivery-watchdog');
  end if;
  perform cron.schedule('grade-delivery-watchdog', '35 6 * * *', 'select public.grade_delivery_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'grade-delivery-watchdog', 'error', sqlerrm));
end $$;
