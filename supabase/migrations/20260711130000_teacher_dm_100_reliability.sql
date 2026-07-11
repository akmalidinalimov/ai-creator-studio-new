-- Teacher-DM 100% delivery (2026-07-11). Owner requirement: the 08:00 quiet-hours flush must
-- work every single time, for every single student. Two remaining holes closed:
--
--   HOLE 1: a queue row that was NEVER CREATED (capture crashed between the submission upsert and
--   the queue insert, or a DB blip) had no recovery — the notification simply didn't exist.
--   -> reconcile_teacher_dm_queue(): every 15 min, re-derives missing queue rows from
--      homework_submissions itself (the source of truth), same self-healing pattern as
--      reconcile_all_xp(). A submission can no longer exist without its teacher notification.
--
--   HOLE 2: if the edge-function drainer is broken (rotated secret, bad deploy), rows pile up and
--   the watchdog ALERTS but nothing DELIVERS until a human intervenes.
--   -> hw_dm_fallback_deliver(): pure SQL + pg_net, sends any DM still unsent 15+ min past due
--      DIRECTLY to the Telegram API (token from platform_settings), with the same post-link and
--      grade buttons. Runs at :20/:50 every hour — the 03:20 UTC run IS the "08:00 watchdog"
--      (08:20 Tashkent, right after the morning flush). Respects quiet hours. If it had to
--      deliver anything, it DMs the admins that the primary path needs attention.
--
-- Delivery legs, independent of each other:
--   1. every-minute edge drainer (rich message, retries transient errors)
--   2. SQL fallback deliverer (claims anything >15 min overdue)
--   3. hourly watchdog alert + hourly ungraded-homework reminder (human backstops)

-- ---------- HOLE 1: queue reconciler ----------
create or replace function public.reconcile_teacher_dm_queue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _n int := 0;
  _tash timestamptz := now() + interval '5 hours'; -- Tashkent, no DST
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
begin
  -- Quiet-hours-aware schedule for resurrected rows (mirror of the webhook logic).
  if _hour >= 22 then
    _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then
    _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else
    _sched := now();
  end if;

  insert into homework_teacher_dm_queue
    (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
     module_number, task_number, assignment_title, student_name, message_url,
     scheduled_for, queued_for_quiet_hours)
  select hs.id, g.teacher_id, hs.user_id, g.id, a.module_id, a.id,
         m.position + 1, coalesce(a.task_number, 1),
         a.title || ' (tiklandi)',  -- marker: this row was resurrected by the reconciler
         (coalesce(nullif(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), '—')
           || case when coalesce(p.telegram_username,'') <> '' then ' (@' || replace(p.telegram_username,'@','') || ')' else '' end),
         hs.telegram_message_url,
         _sched, (_hour >= 22 or _hour < 8)
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  join homework_assignments a on a.id = hs.assignment_id
  join modules m on m.id = a.module_id
  where hs.source = 'telegram_topic'
    and hs.telegram_message_url is not null
    and hs.score is null                                   -- still needs grading
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'    -- give the live path time to queue first
    and not exists (
      select 1 from homework_teacher_dm_queue q
      where q.submission_id = hs.id and q.message_url = hs.telegram_message_url
    );
  get diagnostics _n = row_count;
  if _n > 0 then
    raise log 'reconcile_teacher_dm_queue resurrected % rows', _n;
  end if;
  return _n;
end;
$$;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;

-- ---------- HOLE 2: SQL-native fallback deliverer ----------
create or replace function public.hw_dm_fallback_deliver()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _tok text;
  _row record;
  _sent int := 0;
  _tash_hour int := extract(hour from now() + interval '5 hours')::int;
  _admin record;
begin
  -- Respect quiet hours: the fallback never pings a teacher at night either.
  if _tash_hour >= 22 or _tash_hour < 8 then return 0; end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _row in
    select q.id, q.student_name, q.module_number, q.task_number, q.assignment_title,
           q.message_url, q.submission_id, t.telegram_id, t.preferred_locale
    from homework_teacher_dm_queue q
    join groups g on g.id = q.group_id and g.teacher_id = q.teacher_id  -- RBAC: still assigned
    join profiles t on t.id = q.teacher_id
      and t.telegram_id is not null and t.notifications_enabled is distinct from false
    where q.sent_at is null
      and q.scheduled_for < now() - interval '15 minutes'  -- primary path has clearly failed
    order by q.scheduled_for
    limit 50
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'chat_id', _row.telegram_id,
          'parse_mode', 'HTML',
          'text', '📝 <b>Yangi topshiriq</b>' || E'\n\n<b>' || coalesce(_row.student_name, '—')
                  || '</b> Modul ' || _row.module_number || ' · Vazifa ' || _row.task_number
                  || ' ni topshirdi' || case when coalesce(_row.assignment_title,'') <> ''
                       then E'\n«' || _row.assignment_title || '»' else '' end,
          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),
            jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id)
          )))
        )
      );
      update homework_teacher_dm_queue
        set sent_at = now(), error = 'sql_fallback_delivery' where id = _row.id;
      _sent := _sent + 1;
    exception when others then
      update homework_teacher_dm_queue
        set error = 'sql_fallback_err: ' || left(sqlerrm, 200) where id = _row.id;
    end;
  end loop;

  -- If the fallback had to act, the primary path is sick — tell the admins (max 1 alert / 2h).
  if _sent > 0 and not exists (
    select 1 from notifications_log
    where notification_type = 'hw_dm_fallback' and sent_at > now() - interval '2 hours'
  ) then
    for _admin in
      select distinct p.id, p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('chat_id', _admin.telegram_id,
            'text', '🛟 Zaxira kanal ' || _sent || ' ta o''qituvchi DM yetkazdi — asosiy drainer (notify-homework-submission) ishlamayapti. Tekshiring.'));
        insert into notifications_log (user_id, notification_type, sent_at)
        values (_admin.id, 'hw_dm_fallback', now());
        exit; -- one log row is enough for the rate-limit
      exception when others then null;
      end;
    end loop;
  end if;

  return _sent;
end;
$$;
revoke execute on function public.hw_dm_fallback_deliver() from public, anon, authenticated;

-- ---------- schedules ----------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-teacher-dm-queue') then
    perform cron.unschedule('reconcile-teacher-dm-queue');
  end if;
  perform cron.schedule('reconcile-teacher-dm-queue', '*/15 * * * *',
    $cmd$ select public.reconcile_teacher_dm_queue() $cmd$);

  if exists (select 1 from cron.job where jobname = 'hw-dm-fallback-deliver') then
    perform cron.unschedule('hw-dm-fallback-deliver');
  end if;
  -- :20/:50 hourly — the 03:20 UTC run is the dedicated 08:20-Tashkent morning-flush check.
  perform cron.schedule('hw-dm-fallback-deliver', '20,50 * * * *',
    $cmd$ select public.hw_dm_fallback_deliver() $cmd$);
end $$;
