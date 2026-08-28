-- Lead capture for the public challenge landing ("/" Split Hero).
-- The landing form POSTs to the submit-lead edge function (verify_jwt=false, via the /sb same-origin
-- proxy so it lands even on filtered networks). That fn inserts here (service_role bypasses RLS) and
-- DMs admins via the shared sendTelegram (non-delivery is DB-visible BY CONSTRUCTION). This migration
-- adds the store + a detect-only watchdog so a captured-but-unannounced lead (notify path broke) is
-- surfaced BEFORE the lead is silently lost. Leads are never auto-pruned (sales data — keep).

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null,
  phone       text not null,
  source      text not null default 'landing',
  status      text not null default 'new',
  notified    boolean not null default false,
  user_agent  text,
  ip          text,
  dedupe_key  text,
  metadata    jsonb not null default '{}'::jsonb
);
-- Belt-and-suspenders idempotency: ensure the column exists even if the table pre-existed.
alter table public.leads add column if not exists dedupe_key text;

create index if not exists idx_leads_created on public.leads (created_at desc);
create index if not exists idx_leads_phone on public.leads (phone);
create index if not exists idx_leads_unnotified on public.leads (created_at) where notified = false;
-- Atomic per-phone dedupe: submit-lead upserts on dedupe_key (phone + ~10-min bucket) so a double-tap
-- / retry is a DB-level no-op (ON CONFLICT DO NOTHING) instead of a read-then-insert race.
create unique index if not exists uq_leads_dedupe on public.leads (dedupe_key) where dedupe_key is not null;

alter table public.leads enable row level security;
-- Admin-read only; inserts happen ONLY via the submit-lead edge function (service_role bypasses RLS).
-- No insert/select policy for anon/authenticated → never PostgREST-writable or -readable.
drop policy if exists "leads admin read" on public.leads;
create policy "leads admin read" on public.leads
  for select using (public.has_role(auth.uid(), 'admin'));

-- ------------------------------------------------------------------------------------------------
-- Watchdog: every run reports lead flow to admin_actions (so the digest/GitHub verifier sees lead
-- volume), and DMs admins ONLY when a lead was captured but NOT announced (notified=false older than
-- 15m) — i.e. the edge fn died before notifying and a lead would otherwise be lost. Detect-only.
create or replace function public.leads_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _h int; _d int; _stuck int; _report jsonb; _tok text; _admin record; _msg text;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _alarm boolean;
begin
  select
    count(*) filter (where created_at > now()-interval '1 hour'),
    count(*) filter (where created_at > now()-interval '24 hours'),
    count(*) filter (where notified = false and created_at < now()-interval '15 minutes')
  into _h, _d, _stuck
  from public.leads;

  _alarm := _stuck > 0;
  _report := jsonb_build_object('window','rolling','last_hour',_h,'last_24h',_d,
                                'stuck_unnotified',_stuck,'alarm',_alarm,'checked_at',now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'leads_report', _report);
  exception when others then null; end;

  select value into _state from app_settings where key='leads_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if; -- re-alert every 6h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered
        then '✅ Lead-bildirishnoma normallashdi.'
        else '⚠️ ' || _stuck || ' ta lead qabul qilindi, lekin admin bildirishnomasi yuborilmadi (notify uzildi). admin_actions "leads_report" ni koʻring.'
      end;
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

  insert into app_settings (key, value) values ('leads_watchdog_state', jsonb_build_object(
    'alerting', _alarm, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end, 'checked_at', now()))
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

-- Cron (idempotent; failure surfaced durably). Every 20 minutes.
do $$
begin
  if exists (select 1 from cron.job where jobname='leads-watchdog') then perform cron.unschedule('leads-watchdog'); end if;
  perform cron.schedule('leads-watchdog', '*/20 * * * *', 'select public.leads_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job','leads-watchdog','error',sqlerrm));
end $$;
