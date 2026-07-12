-- Cron-failure watchdog (2026-07-12 retro, P1).
-- Gap found live: the resubmit-campaign cron logged status='failed' and NO detector fired —
-- it was found only by manual archaeology. If a real job dies (XP reconciler, DM drainer,
-- badge batch), the platform must not stay silent. This teaches the hourly anomaly digest to
-- report cron failures within 55 minutes.
--
-- Mechanism: the anomaly_snapshot jsonb gains 'last_cron_runid'. Each digest run reports
-- failures with runid > baseline, then advances the baseline only through what was actually
-- REPORTED — if more than the 5-per-digest cap fail in one window, the rest surface next hour
-- instead of being silently baselined away (review finding). First run after deploy baselines
-- to max(runid) so history never spams.

create or replace function public.platform_anomaly_digest()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _cur jsonb;
  _prev jsonb;
  _tok text;
  _admin record;
  _lines text := '';
  _n int := 0;
  _cv int; _pv int;
  _last_runid bigint;
  _max_runid bigint;
  _new_baseline bigint;
  _fail record;
  _fail_count int := 0;
begin
  _cur := public.hw_dm_health_stats();
  select value into _prev from platform_settings where key = 'anomaly_snapshot';

  -- Each rule fires only when the condition is bad AND (new or worse than the snapshot).
  -- unsent_overdue: any > 0 is bad
  _cv := coalesce((_cur->>'unsent_overdue')::int, 0);
  _pv := coalesce((_prev->>'unsent_overdue')::int, 0);
  if _cv > 0 and _cv > _pv then _lines := _lines || E'\n• Yuborilmagan DM (15 daq+): ' || _cv; end if;

  -- drainer freshness: > 5 min is bad
  _cv := coalesce((_cur->>'drainer_age_sec')::int, 0);
  _pv := coalesce((_prev->>'drainer_age_sec')::int, 0);
  if _cv > 300 and _pv <= 300 then _lines := _lines || E'\n• Drainer cron to''xtagan: ' || _cv || ' s'; end if;

  -- delivery errors in 24h: growth is bad
  _cv := coalesce((_cur->>'errors_24h')::int, 0);
  _pv := coalesce((_prev->>'errors_24h')::int, 0);
  if _cv > _pv then _lines := _lines || E'\n• Yangi yetkazish xatolari: +' || (_cv - _pv); end if;

  -- fallback deliveries: growth means the primary path needed rescue
  _cv := coalesce((_cur->>'fallback_24h')::int, 0);
  _pv := coalesce((_prev->>'fallback_24h')::int, 0);
  if _cv > _pv then _lines := _lines || E'\n• Zaxira kanal ishladi: +' || (_cv - _pv) || ' DM'; end if;

  -- uncaptured posts: growth is bad (small residuals are known-benign)
  _cv := coalesce((_cur->>'uncaptured_24h')::int, 0);
  _pv := coalesce((_prev->>'uncaptured_24h')::int, 0);
  if _cv > _pv + 2 then _lines := _lines || E'\n• Qo''lga olinmagan postlar o''sdi: ' || _pv || '→' || _cv; end if;

  -- misconfigured groups: any > 0
  _cv := coalesce((_cur->>'misconfigured_groups')::int, 0);
  _pv := coalesce((_prev->>'misconfigured_groups')::int, 0);
  if _cv > 0 and _cv > _pv then _lines := _lines || E'\n• Topik sozlanmagan guruhlar: ' || _cv; end if;

  -- capture gone quiet: > 4 days
  _cv := coalesce((_cur->>'stalest_capture_days')::int, 0);
  _pv := coalesce((_prev->>'stalest_capture_days')::int, 0);
  if _cv > 4 and _pv <= 4 then _lines := _lines || E'\n• Guruhda qabul jim: ' || _cv || ' kun'; end if;

  -- NEW: cron job failures since the last digest run (runid-baselined, alerts exactly once).
  -- Note: one-shot jobs that self-unschedule show status='failed' / 'job canceled' even when
  -- their work committed (see memory: pg-cron-oneshot-quirk) — reported anyway, with the
  -- message, so the reader can judge; the fix is to stop writing self-unscheduling jobs.
  select max(runid) into _max_runid from cron.job_run_details;
  _max_runid := coalesce(_max_runid, 0);
  _last_runid := coalesce((_prev->>'last_cron_runid')::bigint, _max_runid);
  _new_baseline := _max_runid;
  for _fail in
    select d.runid, coalesce(j.jobname, left(d.command, 40)) as jobname,
           coalesce(d.return_message, '?') as msg
    from cron.job_run_details d
    left join cron.job j on j.jobid = d.jobid
    where d.runid > _last_runid and d.status = 'failed'
    order by d.runid
    limit 5
  loop
    _lines := _lines || E'\n• Cron XATO: ' || _fail.jobname || ' — ' || left(_fail.msg, 80);
    _fail_count := _fail_count + 1;
    if _fail_count = 5 then
      -- Cap hit: advance the baseline only through what was shown, so failures #6+
      -- surface in the NEXT digest instead of vanishing.
      _new_baseline := _fail.runid;
      _lines := _lines || E'\n  (qolganlari keyingi soatda ko''rsatiladi)';
    end if;
  end loop;
  _cur := _cur || jsonb_build_object('last_cron_runid', _new_baseline);

  -- persist the snapshot regardless (so recovery also resets the baseline)
  insert into platform_settings (key, value, updated_at)
  values ('anomaly_snapshot', _cur, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  if _lines = '' then return 0; end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _admin in
    select distinct p.id, p.telegram_id from profiles p
    join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
    where p.telegram_id is not null limit 3
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type','application/json'),
        body := jsonb_build_object('chat_id', _admin.telegram_id,
          'text', '🤖 Platforma monitoringi — yangi anomaliyalar:' || _lines
                  || E'\n\nTafsilot: hw_dm_health_stats() / homework_teacher_dm_queue.error'));
      _n := _n + 1;
    exception when others then null;
    end;
  end loop;
  return _n;
end;
$$;
revoke execute on function public.platform_anomaly_digest() from public, anon, authenticated;
