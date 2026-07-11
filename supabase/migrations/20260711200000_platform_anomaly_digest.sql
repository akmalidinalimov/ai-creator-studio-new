-- Platform anomaly digest → owner's Telegram (2026-07-11 night).
-- The self-learning loop's "always watching" leg: every hour, compare the platform's health
-- signals against the previous snapshot and DM the admins ONLY about NEW or WORSENED anomalies
-- (no repeat noise). Pure SQL + pg_net — independent of the edge-function stack, same survival
-- property as the watchdog. Signals come from hw_dm_health_stats(), which the incident doctrine
-- requires every feature to feed (DB-visible signals only; function-log-only errors are invisible
-- by definition and must be promoted into stats when discovered).

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

do $$
begin
  if exists (select 1 from cron.job where jobname = 'platform-anomaly-digest') then
    perform cron.unschedule('platform-anomaly-digest');
  end if;
  -- hourly at :55, offset from all other jobs
  perform cron.schedule('platform-anomaly-digest', '55 * * * *', $cmd$ select public.platform_anomaly_digest() $cmd$);
end $$;
