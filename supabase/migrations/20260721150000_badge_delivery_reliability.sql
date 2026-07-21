-- Badge DELIVERY reliability + detector (2026-07-21, owner request: an agent that verifies the
-- reward images actually reach students when they hit a milestone).
--
-- Root cause found: notify-badge-award drained badge_award_queue and set sent_at UNCONDITIONALLY —
-- it never checked whether Telegram accepted the message, and swallowed send exceptions with only
-- console.error. So a badge that failed to deliver (bot blocked, user never pressed Start, Telegram
-- API error) was stamped "sent" anyway, and the failure lived ONLY in function logs — invisible to
-- every DB watchdog. That violates the CLAUDE.md rule "new features must emit DB-visible health
-- signals." The edge function is fixed in the same PR to record real success/failure; this migration
-- gives the queue the columns to record it, a health function, a watchdog, and a digest line.
--
-- NOTE: the drainer cron `notify-badge-award-every-minute` (every minute) lives in prod out-of-band
-- (set during the 2026-07-05 cutover with a Vault-authed net.http_post, like all 15 crons) and is
-- intentionally NOT reproduced here — codifying the auth'd cron commands is a separate chore. The
-- health function references it only for an informational `drainer_age_sec`; no alarm keys on it.

-- 1) Delivery bookkeeping on the queue. Nullable/defaulted → metadata-only, no rewrite of the live table.
alter table public.badge_award_queue add column if not exists error text;
alter table public.badge_award_queue add column if not exists attempts int not null default 0;
alter table public.badge_award_queue add column if not exists last_attempt_at timestamptz;

-- 2) Read-only delivery health — mirrors hw_dm_health_stats() shape. Consumed by the daily digest,
--    the badge watchdog, and the out-of-band hw-dm-health verifier endpoint.
--    overdue_unsent = badges that SHOULD have gone out (scheduled in the past) but are still unsent
--    and NOT yet terminal (terminal failures get sent_at set) and under the retry cap — i.e. the
--    genuine backlog the drainer is failing to clear. undeliverable_24h = terminal "bot blocked /
--    never started" rows (expected for the ~70% who never press Start — informational, not an alarm).
--    Intentional skips (no telegram_id / notifications off) are stamped error='skip:%' by the drainer
--    so they inflate neither the sent nor the undeliverable count.
create or replace function public.badge_dm_health_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _overdue_unsent int;
  _oldest_overdue_sec int;
  _errors_pending int;
  _sent_24h int;
  _undeliverable_24h int;
  _drainer_age_sec int;
begin
  select count(*), coalesce(extract(epoch from now() - min(scheduled_for))::int, 0)
    into _overdue_unsent, _oldest_overdue_sec
  from public.badge_award_queue
  where sent_at is null and scheduled_for < now() - interval '30 minutes' and coalesce(attempts,0) < 5;

  select count(*) into _errors_pending
  from public.badge_award_queue where sent_at is null and error is not null;

  -- Genuine sends only (error IS NULL). Skips ('skip:%') and failures (error set) excluded.
  select count(*) into _sent_24h
  from public.badge_award_queue where sent_at > now() - interval '24 hours' and error is null;

  select count(*) into _undeliverable_24h
  from public.badge_award_queue
  where sent_at > now() - interval '24 hours' and error is not null and error not like 'skip:%';

  -- Freshness of the every-minute drainer cron (if it dies, badges stop flowing silently).
  select coalesce(extract(epoch from now() - max(r.start_time))::int, 999999) into _drainer_age_sec
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
  where j.jobname = 'notify-badge-award-every-minute' and r.status = 'succeeded';

  return jsonb_build_object(
    'overdue_unsent', _overdue_unsent,
    'oldest_overdue_sec', _oldest_overdue_sec,
    'errors_pending', _errors_pending,
    'sent_24h', _sent_24h,
    'undeliverable_24h', _undeliverable_24h,
    'drainer_age_sec', _drainer_age_sec,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.badge_dm_health_stats() from public, anon, authenticated;
grant execute on function public.badge_dm_health_stats() to service_role;

-- 3) Watchdog: the every-minute drainer already auto-retries (once failed rows stay unsent), so this
--    only ALERTS — DMs admins when a real backlog persists (badges scheduled >60 min ago still
--    undelivered → drainer down or a persistent transient failure). De-duped hourly via app_settings,
--    with a recovery ping, exactly like the canary. Independent SQL + pg_net leg (no edge dependency).
create or replace function public.badge_dm_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text;
  _stuck int;
  _oldest_min int;
  _state jsonb;
  _alerting boolean;
  _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false;
  _recovered boolean := false;
  _msg text;
  _admin record;
begin
  select count(*), coalesce(ceil(extract(epoch from now() - min(scheduled_for))/60)::int, 0)
    into _stuck, _oldest_min
  from public.badge_award_queue
  where sent_at is null and scheduled_for < now() - interval '60 minutes' and coalesce(attempts,0) < 5;

  select value into _state from app_settings where key = 'badge_dm_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _stuck > 0 then
    -- first time it goes bad, or re-alert once an hour while still bad
    if (not _alerting) or (_now_ms - _last_ms > 3600000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered
        then '✅ Nishon yetkazish tiklandi — barcha nishonlar yuborilmoqda.'
        else '🚨 Nishon yetkazishda muammo: ' || _stuck || ' ta nishon ' || _oldest_min ||
             ' daqiqadan beri yuborilmagan. notify-badge-award drenajini tekshiring (badge_award_queue).'
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

  insert into app_settings (key, value)
  values ('badge_dm_watchdog_state', jsonb_build_object(
    'alerting', (_stuck > 0),
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'stuck', _stuck, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('stuck', _stuck, 'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.badge_dm_watchdog() from public, anon, authenticated;
grant execute on function public.badge_dm_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'badge-dm-watchdog') then
    perform cron.unschedule('badge-dm-watchdog');
  end if;
  perform cron.schedule('badge-dm-watchdog', '*/30 * * * *', $cmd$ select public.badge_dm_watchdog() $cmd$);
end $$;

-- 4) Fold badge delivery into the daily ops digest (positive-confirmation heartbeat).
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

  -- Badge delivery line: sent count + any real backlog. Terminal "never pressed Start" rows are
  -- excluded from the alarm (they're expected) but shown as info.
  _badge_line := 'Nishonlar: ' || coalesce((_badge->>'sent_24h'),'0') || ' yuborildi' ||
    case when coalesce((_badge->>'overdue_unsent')::int,0) > 0
         then ' · ⚠️ ' || (_badge->>'overdue_unsent') || ' kechikkan' else ' ✅' end ||
    case when coalesce((_badge->>'undeliverable_24h')::int,0) > 0
         then ' (' || (_badge->>'undeliverable_24h') || ' yetkazib bo''lmadi)' else '' end;

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
