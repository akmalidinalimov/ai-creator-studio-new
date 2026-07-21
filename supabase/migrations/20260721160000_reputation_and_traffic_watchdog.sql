-- Firewall-block detection layer (2026-07-21, owner request: detect when the site is blocked on the
-- student side and alert Telegram). A client-side firewall block can't be seen server-side (the
-- blocked request never arrives), so we detect it two ways, defence-in-depth:
--   1) domain-reputation monitor (reputation-check edge fn) — the LEADING CAUSE. Catches the domain
--      getting (re-)flagged malicious/phishing before students hit a wall. Table below + edge fn.
--   2) web-traffic watchdog (this file) — the BACKSTOP for blocks that don't come from a reputation
--      flag. Watches for a dramatic drop in web sign-ins (auth_events) during normally-busy hours.
-- Both DM admins directly (independent SQL/edge legs) and fold into the daily digest.

-- 1) Reputation check log — every reputation-check run appends here (DB-visible signal). Service-role
--    only (RLS on, no policies); the edge fn writes with the service key.
create table if not exists public.domain_reputation_checks (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  source text not null,                     -- 'safe_browsing' | 'virustotal'
  flagged boolean not null default false,
  malicious_count int not null default 0,
  ok boolean not null default true,         -- whether the upstream API call itself succeeded
  detail jsonb
);
alter table public.domain_reputation_checks enable row level security;
create index if not exists idx_domain_rep_recent on public.domain_reputation_checks (source, checked_at desc);

-- 2) Web-traffic watchdog. Compares sign-ins in the last 3h to the average of the same trailing-3h
--    window over the previous 7 days. Alerts ONLY on a dramatic drop during active hours (normally
--    busy → near-silent), which is what a mass firewall/AV block or a site outage looks like.
--    Conservative by design (baseline floor + 85% drop) to avoid false alarms. De-duped via app_settings.
create or replace function public.web_traffic_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record;
  _tz constant text := 'Asia/Tashkent';
  _h int := extract(hour from now() at time zone _tz)::int;
  _current int; _baseline numeric;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _bad boolean; _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  -- Only judge during active hours (09:00–22:00 Tashkent); nights are naturally quiet.
  if _h < 9 or _h >= 22 then return jsonb_build_object('skipped','off_hours'); end if;

  select count(*) into _current from auth_events
   where event='sign_in' and created_at > now() - interval '3 hours';

  select coalesce(avg(cnt),0) into _baseline from (
    select (select count(*) from auth_events e
            where e.event='sign_in'
              and e.created_at >  now() - (g||' days')::interval - interval '3 hours'
              and e.created_at <= now() - (g||' days')::interval) as cnt
    from generate_series(1,7) g
  ) z;

  select value into _state from app_settings where key='web_traffic_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  -- "Bad" = a normally-busy window (baseline ≥ 12) collapsed to ≤15% of normal.
  _bad := (_baseline >= 12 and _current <= _baseline * 0.15);
  if _bad then
    if (not _alerting) or (_now_ms - _last_ms > 3600000) then _should_alert := true; end if;
  elsif _alerting and _current > _baseline * 0.4 then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered
        then '✅ Veb-trafik tiklandi — kirishlar normal holatga qaytdi.'
        else '🚨 Veb-trafik keskin tushdi: oxirgi 3 soatda ' || _current || ' ta kirish (odatda ~' ||
             round(_baseline) || '). Firewall/AV blokirovkasi yoki sayt ishlamayotgan bo''lishi mumkin — tekshiring.'
      end;
      for _admin in
        select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id=p.id and r.role in ('admin','superadmin')
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

  insert into app_settings (key, value) values ('web_traffic_state', jsonb_build_object(
    'alerting', _bad, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'current', _current, 'baseline', round(_baseline), 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('current', _current, 'baseline', round(_baseline), 'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.web_traffic_watchdog() from public, anon, authenticated;
grant execute on function public.web_traffic_watchdog() to service_role;

-- 3) Crons: traffic watchdog every 30 min; reputation-check edge fn twice daily at 09:00 & 20:00
--    Tashkent (04:00 & 15:00 UTC — active hours), Vault-authed net.http_post like canary-15min.
do $$
begin
  if exists (select 1 from cron.job where jobname='web-traffic-watchdog') then perform cron.unschedule('web-traffic-watchdog'); end if;
  perform cron.schedule('web-traffic-watchdog', '*/30 * * * *', $cmd$ select public.web_traffic_watchdog() $cmd$);
  if exists (select 1 from cron.job where jobname='reputation-check-12h') then perform cron.unschedule('reputation-check-12h'); end if;
  perform cron.schedule('reputation-check-12h', '0 4,15 * * *', $cmd$
    select net.http_post(
      url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/reputation-check',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer '||public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      body := '{}'::jsonb)
  $cmd$);
end $$;

-- 4) Fold a reputation snapshot into the daily digest. Faithful superset of the PR #36 version
--    (badge line kept); adds a reputation-snapshot line + alarm hook.
create or replace function public.ops_daily_digest()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text;
  _admin record;
  _n int := 0;
  _since timestamptz := now() - interval '24 hours';
  _health jsonb;
  _hw_dm int; _badge_dm int; _reminders int;
  _retagged int; _autoreg int; _backfill int;
  _stats jsonb; _stats_ran int; _stats_line text;
  _joiners int;
  _cron_ok int; _cron_fail int; _errors int;
  _agent_runs int; _agent_prs int; _agent_issues int;
  _agent_pr_refs text; _agent_issue_refs text; _agent_block text;
  _badge jsonb; _badge_line text;
  _rep_sb jsonb; _rep_vt jsonb; _rep_line text; _rep_flagged boolean := false; _rep_broken boolean := false;
  _msg text;
begin
  select public.hw_dm_health_stats() into _health;
  select public.badge_dm_health_stats() into _badge;

  select count(*) into _hw_dm from admin_actions where action='homework_submission_dm_sent' and created_at > _since;
  select count(*) into _badge_dm from admin_actions where action='badge_dm_sent' and created_at > _since;
  select count(*) into _reminders from admin_actions where action='ungraded_homework_reminder_sent' and created_at > _since;
  select count(*) into _retagged from admin_actions where action='homework_retagged' and created_at > _since;
  select count(*) into _autoreg from admin_actions where action='auto_registered_provisional' and created_at > _since;
  select count(*) into _backfill from admin_actions where action='badge_backfill' and created_at > _since;
  select count(*) into _joiners from new_student_alert_queue where created_at > _since;
  select count(*) into _errors from platform_error_log where occurred_at > _since;

  select count(*) filter (where status='succeeded'), count(*) filter (where status='failed')
    into _cron_ok, _cron_fail
  from cron.job_run_details where start_time > _since;

  select count(*) into _stats_ran
  from cron.job_run_details d join cron.job j on j.jobid=d.jobid
  where j.jobname='verify-student-stats-integrity' and d.status='succeeded' and d.start_time > _since;

  select context into _stats from platform_error_log
    where source='stats-integrity' and action='daily_verify' and occurred_at > _since
    order by occurred_at desc limit 1;

  if _stats_ran = 0 then
    _stats_line := 'Statistika: ⚠️ tekshiruv ishlamadi (verify-student-stats-integrity)';
  elsif _stats is null then
    _stats_line := 'Statistika: ✅ toza (tuzatish shart emas)';
  else
    _stats_line := 'Statistika: ' ||
      coalesce((_stats->>'healed_missing'),'0') || ' XP tiklandi · ' ||
      coalesce((_stats->>'drift_fixed'),'0') || ' total tuzatildi' ||
      case when coalesce((_stats->>'residual_missing')::int,0) > 0
           then ' · ⚠️ ' || (_stats->>'residual_missing') || ' hal qilinmadi' else '' end;
  end if;

  _badge_line := 'Nishonlar: ' || coalesce((_badge->>'sent_24h'),'0') || ' yuborildi' ||
    case when coalesce((_badge->>'overdue_unsent')::int,0) > 0
         then ' · ⚠️ ' || (_badge->>'overdue_unsent') || ' kechikkan' else ' ✅' end ||
    case when coalesce((_badge->>'undeliverable_24h')::int,0) > 0
         then ' (' || (_badge->>'undeliverable_24h') || ' yetkazib bo''lmadi)' else '' end;

  -- Reputation snapshot (latest per source). Only shown when the monitor is active (has data).
  -- The ALARM keys on Safe Browsing only — it's the authoritative source that causes real browser
  -- blocks. VirusTotal is a noisy aggregator shown for info (its regressions are alerted in real time
  -- by the reputation-check edge fn); folding its standing ~11 flags into the alarm would keep the
  -- digest permanently ⚠️. A broken monitor (ok=false) DOES trip the alarm.
  select to_jsonb(t) into _rep_sb from (select flagged, malicious_count, ok from domain_reputation_checks
    where source='safe_browsing' order by checked_at desc limit 1) t;
  select to_jsonb(t) into _rep_vt from (select flagged, malicious_count, ok from domain_reputation_checks
    where source='virustotal' order by checked_at desc limit 1) t;
  _rep_flagged := coalesce((_rep_sb->>'flagged')::boolean, false);
  _rep_broken  := (_rep_sb is not null and not coalesce((_rep_sb->>'ok')::boolean, true))
               or (_rep_vt is not null and not coalesce((_rep_vt->>'ok')::boolean, true));
  if _rep_sb is not null or _rep_vt is not null then
    _rep_line := '   Reputatsiya: ' ||
      (case when _rep_sb is null then 'SB —'
            when not coalesce((_rep_sb->>'ok')::boolean, true) then 'SB ⚠️ tekshiruv xato'
            when (_rep_sb->>'flagged')::boolean then 'SB ⚠️ bloklandi' else 'SB ✅' end) || ' · ' ||
      (case when _rep_vt is null then 'VT —'
            when not coalesce((_rep_vt->>'ok')::boolean, true) then 'VT ⚠️ tekshiruv xato'
            when coalesce((_rep_vt->>'malicious_count')::int,0) > 0 then 'VT ' || (_rep_vt->>'malicious_count') || ' belgi' else 'VT ✅' end)
      || E'\n';
  else
    _rep_line := '';
  end if;

  select count(*) filter (where outcome_type='pr'),
         count(*) filter (where outcome_type='issue'),
         string_agg(distinct 'PR #'||outcome_ref, ', ') filter (where outcome_type='pr'),
         string_agg(distinct 'issue #'||outcome_ref, ', ') filter (where outcome_type='issue')
    into _agent_prs, _agent_issues, _agent_pr_refs, _agent_issue_refs
  from ops_agent_runs where created_at > _since and outcome_ref is not null and outcome_ref <> '';
  select count(*) into _agent_runs from ops_agent_runs where created_at > _since;

  if _agent_runs > 0 then
    _agent_block := E'\n🕵️ <b>Avtonom agent</b>' || E'\n' ||
      '   Ishga tushdi: ' || _agent_runs || ' marta' || E'\n' ||
      (case when coalesce(_agent_prs,0) > 0 then '   Tuzatish PR ochdi: ' || _agent_pr_refs || E'\n' else '' end) ||
      (case when coalesce(_agent_issues,0) > 0 then '   Muammo qayd etdi: ' || _agent_issue_refs || E'\n' else '' end) ||
      (case when coalesce(_agent_prs,0)=0 and coalesce(_agent_issues,0)=0
            then '   Harakat talab qilinmadi (muammo topilmadi)' || E'\n' else '' end);
  else
    _agent_block := '';
  end if;

  _msg :=
    '🤖 <b>Kunlik avto-hisobot</b> (24 soat)' || E'\n\n' ||
    '🔧 <b>Avtomatik tuzatish</b>' || E'\n' ||
    '   ' || _stats_line || E'\n' ||
    '   ' || _badge_line || E'\n' ||
    '   Yo''qolgan bildirishnomalar tiklandi: ' || coalesce((_health->>'resurrected_24h'),'0') || E'\n' ||
    (case when _backfill > 0 then '   Nishonlar backfill: ' || _backfill || E'\n' else '' end) ||
    (case when _retagged > 0 then '   Vazifa qayta teglandi: ' || _retagged || E'\n' else '' end) ||
    _agent_block ||
    E'\n' ||
    '📨 <b>Yetkazildi</b>' || E'\n' ||
    '   Vazifa bildirishnomalari: ' || _hw_dm || E'\n' ||
    '   Nishon xabarlari: ' || _badge_dm || E'\n' ||
    '   Baholash eslatmalari: ' || _reminders || E'\n\n' ||
    '🆕 <b>Yangi talabalar</b>: ' || _joiners ||
    (case when _autoreg > 0 then ' (' || _autoreg || ' avto-ro''yxat)' else '' end) || E'\n\n' ||
    '⚙️ <b>Tizim salomatligi</b>' || E'\n' ||
    _rep_line ||
    '   Cron: ' || _cron_ok || ' ✅' ||
      (case when _cron_fail > 0 then ' · ' || _cron_fail || ' ⚠️' else '' end) || E'\n' ||
    '   Yetkazish xatolari: ' || coalesce((_health->>'errors_24h'),'0') || E'\n' ||
    '   Qamrab olinmagan post: ' || coalesce((_health->>'uncaptured_24h'),'0') || E'\n' ||
    '   Xatolar jurnali: ' || _errors ||
      (case when _errors > 0 then ' ⚠️ (platform_error_log ni ko''ring)' else ' ✅' end) || E'\n\n' ||
    (case
       when _stats_ran = 0 or coalesce((_stats->>'residual_missing')::int,0) > 0 or _errors > 0
            or coalesce((_health->>'unsent_overdue')::int,0) > 0
            or coalesce((_badge->>'overdue_unsent')::int,0) > 0
            or _rep_flagged or _rep_broken
       then '📊 <b>Umumiy: ⚠️ E''tibor talab qiladi</b> — tafsilotlar yuqorida.'
       else '📊 <b>Umumiy: ✅ Hammasi sog''lom.</b>'
     end);

  select value->>'bot_token' into _tok from platform_settings where key='telegram';
  if _tok is null or _tok='' then return 0; end if;

  for _admin in
    select distinct p.telegram_id from profiles p
    join user_roles r on r.user_id=p.id and r.role in ('admin','superadmin')
    where p.telegram_id is not null limit 3
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type','application/json'),
        body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg, 'parse_mode', 'HTML'));
      _n := _n + 1;
    exception when others then null;
    end;
  end loop;
  return _n;
end;
$fn$;

revoke execute on function public.ops_daily_digest() from public, anon, authenticated;
grant execute on function public.ops_daily_digest() to service_role;
