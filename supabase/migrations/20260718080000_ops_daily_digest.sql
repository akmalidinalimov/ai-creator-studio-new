-- Daily ops heartbeat → owner's Telegram (2026-07-18, owner request: visibility into the
-- autonomous systems). The anomaly digest only speaks when something is WRONG; this is the
-- positive-confirmation counterpart — every morning it DMs the admins a summary of what the
-- reconcilers / verifiers / delivery legs / crons actually did in the last 24h, and what they
-- healed. Pure SQL + pg_net, independent of the edge stack (same survival property as the other
-- watchdog legs). Everything it reports is DB-visible (admin_actions, platform_error_log,
-- hw_dm_health_stats, cron.job_run_details) — no guessing.

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
  _msg text;
begin
  select public.hw_dm_health_stats() into _health;

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

  -- Did the stats verifier actually run (succeeded) in the window?
  select count(*) into _stats_ran
  from cron.job_run_details d join cron.job j on j.jobid=d.jobid
  where j.jobname='verify-student-stats-integrity' and d.status='succeeded' and d.start_time > _since;

  -- Its latest result (a clean run leaves no platform_error_log row).
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

  _msg :=
    '🤖 <b>Kunlik avto-hisobot</b> (24 soat)' || E'\n\n' ||
    '🔧 <b>Avtomatik tuzatish</b>' || E'\n' ||
    '   ' || _stats_line || E'\n' ||
    '   Yo''qolgan bildirishnomalar tiklandi: ' || coalesce((_health->>'resurrected_24h'),'0') || E'\n' ||
    (case when _backfill > 0 then '   Nishonlar backfill: ' || _backfill || E'\n' else '' end) ||
    (case when _retagged > 0 then '   Vazifa qayta teglandi: ' || _retagged || E'\n' else '' end) ||
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

-- Daily at 05:05 UTC (10:05 Tashkent) — after the morning batch + the stats verifier (04:40),
-- so it reports on a fully-settled day.
do $$
begin
  if exists (select 1 from cron.job where jobname='ops-daily-digest') then
    perform cron.unschedule('ops-daily-digest');
  end if;
  perform cron.schedule('ops-daily-digest', '5 5 * * *', $cmd$ select public.ops_daily_digest() $cmd$);
end $$;
