-- HTML-escape class fix: hw_dm_fallback_deliver() — the SQL fallback leg (3rd delivery path,
-- alongside the webhook's instant DM and the notify-homework-submission cron drainer) for the
-- teacher homework DM builds its Telegram message with parse_mode 'HTML' but interpolates
-- student_name / assignment_title WITHOUT escaping. A '&', '<', or '>' in either free-text value
-- makes Telegram reject the whole send ("can't parse entities"), and since this is the leg that
-- fires when the other two have already failed, that submission's teacher DM is lost on ALL
-- three paths.
--
-- Fix: CREATE OR REPLACE, copied VERBATIM from the current definition
-- (supabase/migrations/20260818190000_group_teachers_multi.sql:879-963), changing ONLY the two
-- free-text interpolations to the same SQL HTML-escape already used elsewhere in this repo
-- (precedent: supabase/migrations/20260813221016_group_weekly_board.sql:126-128):
--   replace(replace(replace(<expr>, '&','&amp;'), '<','&lt;'), '>','&gt;')
-- Everything else — signature, RBAC join, quiet-hours guard, retry/error handling, admin alert,
-- SECURITY DEFINER, search_path — is byte-identical to the current function.

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
    join groups g on g.id = q.group_id and public.is_group_teacher(q.group_id, q.teacher_id)  -- RBAC: still assigned
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
          'text', '📝 <b>Yangi topshiriq</b>' || E'\n\n<b>'
                  || replace(replace(replace(coalesce(_row.student_name, '—'), '&','&amp;'), '<','&lt;'), '>','&gt;')
                  || '</b> Modul ' || _row.module_number || ' · Vazifa ' || _row.task_number
                  || ' ni topshirdi' || case when coalesce(_row.assignment_title,'') <> ''
                       then E'\n«' || replace(replace(replace(_row.assignment_title, '&','&amp;'), '<','&lt;'), '>','&gt;') || '»' else '' end,
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
