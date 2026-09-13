-- Detector for the lead-form-broken class. submit-lead's upsert onConflict couldn't name the PARTIAL unique
-- index uq_leads_dedupe, so EVERY submit 500'd since 2026-08-28 and every lead was silently LOST — undetected
-- for 6 days because `lead_insert_failed` was logged to admin_actions but nothing ALERTED on it, and "0 leads"
-- looks identical to "no traffic". The code fix (submit-lead insert + 23505-skip) stops the loss; this adds
-- the missing alarm so the class can never hide again: leads_watchdog gains a third, independent alarm track
-- that DMs admins on ANY lead_insert_failed in the last hour (an insert failure = a lead lost at the door,
-- so unlike the bitrix backlog it needs no "standing backlog" condition — one failure is already critical).
create or replace function public.leads_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _h int; _d int; _stuck int; _b_unsynced int; _b_fail int; _ins_fail int; _report jsonb;
  _tok text; _admin record; _msg text;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  -- notify (capture) alarm state
  _state jsonb; _alerting boolean; _last_ms bigint; _should_alert boolean := false; _recovered boolean := false;
  _alarm boolean;
  -- bitrix alarm state
  _bstate jsonb; _b_alerting boolean; _b_last_ms bigint; _b_should boolean := false; _b_recovered boolean := false;
  _b_alarm boolean;
  -- insert-failed alarm state
  _istate jsonb; _i_alerting boolean; _i_last_ms bigint; _i_should boolean := false; _i_recovered boolean := false;
  _i_alarm boolean;
begin
  select
    count(*) filter (where created_at > now()-interval '1 hour'),
    count(*) filter (where created_at > now()-interval '24 hours'),
    count(*) filter (where notified = false and created_at < now()-interval '15 minutes'),
    count(*) filter (where bitrix_synced = false and created_at < now()-interval '30 minutes' and created_at > now()-interval '14 days')
  into _h, _d, _stuck, _b_unsynced
  from public.leads;

  select count(*) into _b_fail from public.admin_actions
  where action = 'bitrix_lead_failed' and created_at > now()-interval '1 hour';
  select count(*) into _ins_fail from public.admin_actions
  where action = 'lead_insert_failed' and created_at > now()-interval '1 hour';

  _alarm   := _stuck > 0;
  _b_alarm := (_b_fail > 0) and (_b_unsynced > 0);
  _i_alarm := _ins_fail > 0;
  _report := jsonb_build_object('window','rolling','last_hour',_h,'last_24h',_d,
                                'stuck_unnotified',_stuck,'alarm',_alarm,
                                'bitrix_unsynced',_b_unsynced,'bitrix_failed_1h',_b_fail,'bitrix_alarm',_b_alarm,
                                'insert_failed_1h',_ins_fail,'insert_alarm',_i_alarm,
                                'checked_at',now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'leads_report', _report);
  exception when others then null; end;

  -- capture-notify alarm
  select value into _state from app_settings where key='leads_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if; -- re-alert every 6h
  elsif _alerting then _recovered := true; end if;

  -- bitrix-sync alarm
  select value into _bstate from app_settings where key='leads_bitrix_watchdog_state';
  _b_alerting := coalesce((_bstate->>'alerting')::boolean, false);
  _b_last_ms  := coalesce((_bstate->>'last_alert_ms')::bigint, 0);
  if _b_alarm then
    if (not _b_alerting) or (_now_ms - _b_last_ms > 21600000) then _b_should := true; end if;
  elsif _b_alerting then _b_recovered := true; end if;

  -- insert-failed alarm
  select value into _istate from app_settings where key='leads_insert_watchdog_state';
  _i_alerting := coalesce((_istate->>'alerting')::boolean, false);
  _i_last_ms  := coalesce((_istate->>'last_alert_ms')::bigint, 0);
  if _i_alarm then
    if (not _i_alerting) or (_now_ms - _i_last_ms > 21600000) then _i_should := true; end if;
  elsif _i_alerting then _i_recovered := true; end if;

  if _should_alert or _recovered or _b_should or _b_recovered or _i_should or _i_recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok <> '' then
      _msg := null;
      -- insert-failed FIRST (most severe: leads are being lost at the door)
      if _i_should then
        _msg := '🚨 Lead formasi ISHLAMAYAPTI: soʻnggi soatda ' || _ins_fail || ' ta lead saqlanmadi (insert xatosi) — leadlar YOʻQOLMOQDA. admin_actions "lead_insert_failed" ni koʻring.';
      elsif _i_recovered then
        _msg := '✅ Lead formasi tiklandi (insert xatolari toʻxtadi).';
      end if;
      if _should_alert then
        _msg := coalesce(_msg || E'\n', '') || '⚠️ ' || _stuck || ' ta lead qabul qilindi, lekin admin bildirishnomasi yuborilmadi (notify uzildi). admin_actions "leads_report" ni koʻring.';
      elsif _recovered then
        _msg := coalesce(_msg || E'\n', '') || '✅ Lead-bildirishnoma normallashdi.';
      end if;
      if _b_should then
        _msg := coalesce(_msg || E'\n', '') || '⚠️ Bitrix24 CRM sinxronizatsiyasi uzildi: ' || _b_unsynced || ' ta lead CRM ga yuborilmadi (soʻnggi soatda ' || _b_fail || ' xato). bitrix_error / admin_actions "bitrix_lead_failed" ni koʻring.';
      elsif _b_recovered then
        _msg := coalesce(_msg || E'\n', '') || '✅ Bitrix24 CRM sinxronizatsiyasi normallashdi.';
      end if;
      if _msg is not null and _msg <> '' then
        for _admin in select distinct p.telegram_id from profiles p
          join user_roles r on r.user_id=p.id and r.role in ('admin','superadmin')
          where p.telegram_id is not null limit 3
        loop
          begin
            perform net.http_post(url:='https://api.telegram.org/bot'||_tok||'/sendMessage',
              headers:=jsonb_build_object('Content-Type','application/json'),
              body:=jsonb_build_object('chat_id',_admin.telegram_id,'text',_msg));
          exception when others then null; end;
        end loop;
      end if;
    end if;
  end if;

  insert into app_settings (key, value) values ('leads_watchdog_state', jsonb_build_object(
    'alerting', _alarm, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  insert into app_settings (key, value) values ('leads_bitrix_watchdog_state', jsonb_build_object(
    'alerting', _b_alarm, 'last_alert_ms', case when _b_should then _now_ms else _b_last_ms end, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  insert into app_settings (key, value) values ('leads_insert_watchdog_state', jsonb_build_object(
    'alerting', _i_alarm, 'last_alert_ms', case when _i_should then _now_ms else _i_last_ms end, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

revoke execute on function public.leads_watchdog() from public, anon, authenticated;
grant execute on function public.leads_watchdog() to service_role;

-- Deploy self-test (durably surfaced if it throws).
do $$
begin
  perform public.leads_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'leads_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
