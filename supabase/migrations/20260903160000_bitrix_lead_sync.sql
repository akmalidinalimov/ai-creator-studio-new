-- Bitrix24 CRM sync for landing leads (lead → CRM). The instant path (submit-lead) forwards each captured
-- lead to Bitrix via crm.lead.add; this migration adds the per-lead sync state, a replay-safe retro-mark so
-- existing leads are NOT dumped into Bitrix, a drainer cron to re-forward any the instant push missed, and
-- extends leads_watchdog to alert on a real Bitrix backlog. Dormant until the BITRIX_WEBHOOK_URL edge secret
-- is set — no column here references it; the edge functions read it and skip when unset.

-- 1) Per-lead sync state. bitrix_synced is NOT NULL DEFAULT false (a CONSTANT default → Postgres 11+
--    metadata-only add, no table rewrite); the other three are nullable. The submit-lead upsert never names
--    these columns, so existing rows and the capture path are unaffected.
alter table public.leads add column if not exists bitrix_synced    boolean not null default false;
alter table public.leads add column if not exists bitrix_lead_id   text;
alter table public.leads add column if not exists bitrix_synced_at timestamptz;
alter table public.leads add column if not exists bitrix_error     text;

-- 2) Retro-mark: do NOT back-dump every historical lead into Bitrix when the webhook is first set. Mark the
--    leads that exist NOW as synced so the drainer only ever forwards NEW leads. Guarded two ways: a one-shot
--    app_settings marker (so the "migration SQL can run >1x" quirk can't re-mark a genuinely-new lead), AND a
--    frozen _cutoff captured up front + `created_at <= _cutoff` — so a lead inserted during the deploy (if the
--    runner autocommits statements individually rather than as one txn) is NOT silently marked synced and then
--    never forwarded. Correct regardless of the runner's transaction batching.
do $$
declare _cutoff timestamptz := now();
begin
  if not exists (select 1 from public.app_settings where key = 'bitrix_leads_retromark_done') then
    update public.leads set bitrix_synced = true where bitrix_synced = false and created_at <= _cutoff;
    insert into public.app_settings (key, value)
      values ('bitrix_leads_retromark_done', jsonb_build_object('at', now(), 'cutoff', _cutoff))
      on conflict (key) do nothing;
  end if;
end $$;

-- 3) Drainer lookup index: the unsynced set is tiny, so index only it.
create index if not exists idx_leads_unsynced on public.leads (created_at) where bitrix_synced = false;

-- 4) leads_watchdog v2: same capture-notify alarm as before, PLUS a Bitrix-sync alarm. The Bitrix alarm only
--    fires when there are BOTH real attempted-and-failed forwards in the last hour AND a standing unsynced
--    backlog — so while Bitrix is unconfigured (no attempts → no failures) it never false-alarms, and once
--    configured a persistent failure is surfaced before leads silently miss the CRM. Two independent state
--    keys so the two alarms re-alert / recover on their own.
create or replace function public.leads_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _h int; _d int; _stuck int; _b_unsynced int; _b_fail int; _report jsonb;
  _tok text; _admin record; _msg text;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  -- notify (capture) alarm state
  _state jsonb; _alerting boolean; _last_ms bigint; _should_alert boolean := false; _recovered boolean := false;
  _alarm boolean;
  -- bitrix alarm state
  _bstate jsonb; _b_alerting boolean; _b_last_ms bigint; _b_should boolean := false; _b_recovered boolean := false;
  _b_alarm boolean;
begin
  select
    count(*) filter (where created_at > now()-interval '1 hour'),
    count(*) filter (where created_at > now()-interval '24 hours'),
    count(*) filter (where notified = false and created_at < now()-interval '15 minutes'),
    count(*) filter (where bitrix_synced = false and created_at < now()-interval '30 minutes' and created_at > now()-interval '14 days')
  into _h, _d, _stuck, _b_unsynced
  from public.leads;

  select count(*) into _b_fail
  from public.admin_actions
  where action = 'bitrix_lead_failed' and created_at > now()-interval '1 hour';

  _alarm   := _stuck > 0;
  _b_alarm := (_b_fail > 0) and (_b_unsynced > 0);
  _report := jsonb_build_object('window','rolling','last_hour',_h,'last_24h',_d,
                                'stuck_unnotified',_stuck,'alarm',_alarm,
                                'bitrix_unsynced',_b_unsynced,'bitrix_failed_1h',_b_fail,'bitrix_alarm',_b_alarm,
                                'checked_at',now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'leads_report', _report);
  exception when others then null; end;

  -- capture-notify alarm (unchanged behaviour)
  select value into _state from app_settings where key='leads_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if; -- re-alert every 6h
  elsif _alerting then
    _recovered := true;
  end if;

  -- bitrix-sync alarm (independent track)
  select value into _bstate from app_settings where key='leads_bitrix_watchdog_state';
  _b_alerting := coalesce((_bstate->>'alerting')::boolean, false);
  _b_last_ms  := coalesce((_bstate->>'last_alert_ms')::bigint, 0);
  if _b_alarm then
    if (not _b_alerting) or (_now_ms - _b_last_ms > 21600000) then _b_should := true; end if;
  elsif _b_alerting then
    _b_recovered := true;
  end if;

  if _should_alert or _recovered or _b_should or _b_recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok <> '' then
      _msg := null;
      if _should_alert then
        _msg := '⚠️ ' || _stuck || ' ta lead qabul qilindi, lekin admin bildirishnomasi yuborilmadi (notify uzildi). admin_actions "leads_report" ni koʻring.';
      elsif _recovered then
        _msg := '✅ Lead-bildirishnoma normallashdi.';
      end if;
      -- second (bitrix) message, appended as its own line
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

-- 5) Drainer cron every 15 min (idempotent; failure surfaced durably). Invoked via ops_net_post so any
--    failure is named in ops_http_failures. p_timeout 30s (loops crm.lead.add over up to 50 leads/run).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'bitrix-lead-sync') then
    perform cron.unschedule('bitrix-lead-sync');
  end if;
  perform cron.schedule('bitrix-lead-sync', '*/15 * * * *', $cmd$
    select public.ops_net_post(
      'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/bitrix-lead-sync',
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      'bitrix-lead-sync', 30000)
  $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'bitrix-lead-sync', 'error', sqlerrm));
end $$;
