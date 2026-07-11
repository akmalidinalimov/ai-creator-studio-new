-- Teacher-DM queue hardening (2026-07-11). Two weak points found in review:
--   1. The drainer marked a row "sent" even on TRANSIENT Telegram errors (429 burst at the 08:00
--      quiet-hours flush, 5xx, network blips) — one attempt, silently lost. -> retry_count lets
--      the every-minute cron retry transient failures (capped) instead of giving up.
--   2. pg_cron's "succeeded" only means the HTTP call was ENQUEUED (net.http_post is async), so a
--      permanently-broken drainer (e.g. rotated internal secret -> 403 forever) looks green while
--      nothing sends. -> a SQL-native watchdog that does NOT depend on the edge-function stack
--      alerts admins by DM when the unsent backlog ages or real errors accumulate.

alter table public.homework_teacher_dm_queue
  add column if not exists retry_count int not null default 0;

create or replace function public.hw_dm_queue_watchdog()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _backlog int;
  _errs int;
  _tok text;
  _admin record;
  _msg text;
  _alerted uuid := null;
begin
  -- Unsent rows more than an hour past due = the drainer is not draining.
  select count(*) into _backlog from homework_teacher_dm_queue
   where sent_at is null and scheduled_for < now() - interval '60 minutes';
  -- Real delivery failures in the last 24h (intentional skips excluded).
  select count(*) into _errs from homework_teacher_dm_queue
   where error is not null
     and error not like 'teacher_no_longer%'
     and error not like 'notifications_disabled%'
     and coalesce(sent_at, created_at) > now() - interval '24 hours';
  if coalesce(_backlog, 0) = 0 and coalesce(_errs, 0) = 0 then return; end if;

  -- At most one alert per 6h.
  if exists (select 1 from notifications_log
              where notification_type = 'hw_dm_watchdog' and sent_at > now() - interval '6 hours') then
    return;
  end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return; end if;

  _msg := '⚠️ Vazifa DM navbati ogohlantirishi:' || E'\n'
       || '• Yuborilmagan (1 soatdan eski): ' || _backlog || E'\n'
       || '• Xatolar (24 soat): ' || _errs || E'\n'
       || 'Tekshiring: homework_teacher_dm_queue + notify-homework-submission funksiyasi.';

  for _admin in
    select distinct p.id, p.telegram_id
    from profiles p join user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
    where p.telegram_id is not null
    limit 3
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg)
      );
      if _alerted is null then _alerted := _admin.id; end if;
    exception when others then null; -- alerting is best-effort
    end;
  end loop;

  if _alerted is not null then
    insert into notifications_log (user_id, notification_type, sent_at)
    values (_alerted, 'hw_dm_watchdog', now());
  end if;
end;
$$;
revoke execute on function public.hw_dm_queue_watchdog() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hw-dm-watchdog') then
    perform cron.unschedule('hw-dm-watchdog');
  end if;
  perform cron.schedule('hw-dm-watchdog', '45 * * * *', $cmd$ select public.hw_dm_queue_watchdog() $cmd$);
end $$;
