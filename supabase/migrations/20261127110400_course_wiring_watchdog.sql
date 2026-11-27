-- Detector for the CLAUDE STUDIO incident class (20261127110300): a PUBLISHED course that the Telegram bot cannot
-- reach. The bot recognises a student only through a group whose chat is known (a /c/<id>/ topic link, the group link,
-- a module topic, or daily_task_chat_id) or through the course's channel + holding group. A published course with
-- neither is invisible to the bot: every channel/group member is told "Bu bot faqat AI Creators talabalari uchun.",
-- and nothing anywhere recorded it — CLAUDE STUDIO sat published like that from 11-23 to 11-27 until students
-- complained.
--
--   course_wiring_issues()     pure read: one row per published course the bot cannot reach, with the reason
--   course_wiring_watchdog()   hourly (:38): DMs the admins when the set of such courses CHANGES (new problem, or all
--                              fixed = ✅), keeps its state in app_settings.course_wiring_watchdog_state, writes an
--                              admin_actions row per alert (DB-visible even with no bot token / no admin telegram_id)
-- The rule fires before the first complaint: publishing a course in the admin UI without a connected group or channel
-- is caught within the hour. Kill-switch: unschedule 'course-wiring-watchdog'.

create or replace function public.course_wiring_issues()
returns table(course_id uuid, course_title text, issue text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select c.id, c.title,
         case when not exists (select 1 from public.groups g where g.course_id = c.id and g.id is distinct from c.channel_group_id)
              then 'guruh yo''q'
              else 'guruh(lar)ning Telegram chati ulanmagan'
         end
    from public.courses c
   where c.published
     -- reachable through the channel: chat id + holding group
     and not (c.telegram_channel_chat_id is not null and c.channel_group_id is not null)
     -- reachable through at least one real group whose chat is known
     and not exists (
       select 1 from public.groups g
        where g.course_id = c.id and g.id is distinct from c.channel_group_id
          and (g.daily_task_chat_id is not null
               or exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                           where u ~ '/c/\d+/')
               or exists (select 1 from public.group_module_topics t
                           where t.group_id = g.id and t.telegram_topic_url ~ '/c/\d+/')))
   order by c.title;
$function$;

create or replace function public.course_wiring_watchdog()
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _cur jsonb;
  _rows text;
  _n int;
  _prev jsonb := (select value from public.app_settings where key = 'course_wiring_watchdog_state');
  _prev_set jsonb;
  _action text := 'none';
  _tok text;
  _admin record;
  _dm int := 0;
  _msg text;
begin
  select coalesce(jsonb_agg(course_id::text order by course_id), '[]'::jsonb), count(*),
         string_agg('• ' || course_title || ' — ' || issue, E'\n' order by course_title)
    into _cur, _n, _rows
    from public.course_wiring_issues();

  _prev_set := case when jsonb_typeof(_prev->'courses') = 'array' then _prev->'courses' else '[]'::jsonb end;
  if _cur is distinct from _prev_set then
    _action := case when _n > 0 then 'alert' else 'recovered' end;
  end if;

  if _action <> 'none' then
    _msg := case when _action = 'alert'
      then '⚠️ Bot bu kurs(lar)ni ko''rmayapti (' || _n || '):' || E'\n' || _rows
           || E'\n\nKanal/guruh a''zolari botdan "Bu bot faqat AI Creators talabalari uchun" javobini oladi. '
           || 'Kursga guruh (Telegram chati bilan) yoki kanal ulang.'
      else '✅ Barcha nashr qilingan kurslar botga ulangan.'
    end;
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active'
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'course_wiring_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, case when _action = 'alert' then 'course_wiring_watchdog_ALARM' else 'course_wiring_watchdog_recovered' end,
              jsonb_build_object('courses', _cur, 'issues', _rows, 'dm_attempted', _dm));
    exception when others then null; end;
  end if;

  -- the set is remembered only once an admin was actually messaged, so an undelivered alert is retried next hour
  insert into public.app_settings (key, value)
  values ('course_wiring_watchdog_state', jsonb_build_object(
    'courses', case when _action = 'none' or _dm > 0 then _cur else _prev_set end,
    'current', _cur, 'last_action', _action, 'dm_attempted_last_run', _dm, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('issues', _n, 'action', _action, 'dm_attempted', _dm);
end
$function$;

revoke execute on function public.course_wiring_issues() from public, anon, authenticated;
revoke execute on function public.course_wiring_watchdog() from public, anon, authenticated;
grant execute on function public.course_wiring_issues() to service_role;
grant execute on function public.course_wiring_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'course-wiring-watchdog') then
    perform cron.unschedule('course-wiring-watchdog');
  end if;
  perform cron.schedule('course-wiring-watchdog', '38 * * * *', $cmd$ select public.course_wiring_watchdog() $cmd$);
end $$;

-- self-test (read-only): the issues function plans and runs; the watchdog itself is NOT called here (it can DM).
do $test$
declare _n int;
begin
  select count(*) into _n from public.course_wiring_issues();
  raise notice 'course_wiring_issues at deploy: %', _n;
end $test$;
