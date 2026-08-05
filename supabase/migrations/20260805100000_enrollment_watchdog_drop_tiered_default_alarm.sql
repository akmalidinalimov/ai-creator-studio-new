-- Fix a FALSE ALARM (2026-08-05). enrollment_watchdog (from 20260726120000) alarms when a TIERED
-- course is is_default_for_signup, on the premise "tiered default → new-student creation is broken".
-- But the SAME PR's handle_new_user fix made a tiered default SAFE — it only auto-enrolls into an
-- UNTIERED default and skips tiered ones, so createUser succeeds and the student is enrolled later via
-- group assignment (with the tier). So the tiered-default alarm is obsolete and was firing on a benign,
-- intended state: AI CREATORS 5.0 is the tiered signup default and new students create fine (verified:
-- 8 created in the last 48h, 0 signup failures). Real signup-failure detection is the RUNTIME signal —
-- admin-create-students writes a platform_error_log row on an actual createUser failure (20260726140000),
-- surfaced by the daily digest + anomaly watchdog. Drop the config-based _bad_default alarm here; keep
-- the stray-enrollment detection (still valid). Next run clears the standing alert (→ recovery message).
create or replace function public.enrollment_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _stray int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  _stray := public.stray_enrollment_count();

  select value into _state from app_settings where key = 'enrollment_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _stray > 0 then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;  -- daily re-alert
  elsif _alerting then _recovered := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Enrollment/signup holati normallashdi (yangi talabalar yaratilyapti).'
        else '⚠️ ' || _stray || ' ta talaba noto''g''ri (tugagan) kursga yozilgan — is_default_for_signup ni tekshiring.'
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
  end if;

  insert into app_settings (key, value) values ('enrollment_watchdog_state', jsonb_build_object(
    'alerting', (_stray > 0), 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'stray', _stray, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('stray', _stray, 'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.enrollment_watchdog() from public, anon, authenticated;
grant execute on function public.enrollment_watchdog() to service_role;
