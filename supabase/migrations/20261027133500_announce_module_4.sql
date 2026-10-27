-- Tell the Challenge 6.0 students that module 4 is open (owner, 2026-10-27: "yes"). Module 4 «CLAUDE AI VA CODEX BILAN
-- AVTOMATLASHTIRISH» was opened by 20261027131000 (tier AC CHALLENGE module_limit 4): 8 lessons, 1 homework.
-- Same mechanism as the earlier module announcement (20261013190800). 5-GURUH has no NETWORKING topic yet: DMs only.
--
-- 1. DM, in each student's language: the normal broadcast pipeline — one broadcasts row + one pending
--    broadcast_deliveries row per student of a course-6.0 group who pressed Start, active, not archived, not staff.
--    The broadcast-drainer defers quiet hours (22–08 Tashkent) to 08:00 and records every outcome. Respects the
--    broadcast kill-switch.
-- 2. Group post (uz) in each group's NETWORKING topic (groups.networking_thread_id, 20261012074100) at 08:30 Tashkent —
--    before the 09:00 group-room greeting in the same topic, never in quiet hours. Applied during the day (08:00–21:59)
--    it posts at once; otherwise a one-shot cron at the next 08:30 calls announce_module_4_groups(), which posts once
--    (audit marker) and unschedules itself. Through ops_net_post (purpose 'module_4_announcement').
-- Replay-safe: one audit marker per part.

create or replace function public.announce_module_4_groups()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _marker constant text := 'module_4_groups_20261027';
  _tok text;
  _g record;
  _posts jsonb := '[]'::jsonb;
  _text constant text :=
    '🤖 <b>4-modul ochildi!</b>' || E'\n\n' ||
    'Endi «<b>Claude AI va Codex bilan avtomatlashtirish</b>» moduli hammaga ochiq: <b>8 ta yangi dars</b> va <b>1 ta uyga vazifa</b>.' || E'\n\n' ||
    '▶️ Boshlash: botdagi «🚀 Ilovani ochish» tugmasi → 4-modul.' || E'\n\n' ||
    '📚 Har bir dars — <b>+20 ball</b>' || E'\n' ||
    '📝 Uyga vazifa — <b>+15 ball</b>' || E'\n' ||
    '⭐️ 9–10 baho — yana <b>+25 ball</b>' || E'\n\n' ||
    'Ishingizni AI bilan avtomatlashtirishni boshlaymiz — natijalaringizni shu yerda kutamiz! ⚙️🔥';
begin
  -- the one-shot never runs twice, whatever happens below
  perform cron.unschedule(jobid) from cron.job where jobname = 'announce-module-4-groups';
  if exists (select 1 from public.admin_actions where action = 'group_announcement_posted' and details->>'marker' = _marker) then
    return jsonb_build_object('status', 'already');
  end if;
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'group_announcement_failed', jsonb_build_object('marker', _marker, 'error', 'no bot token'));
    return jsonb_build_object('status', 'no_token');
  end if;
  for _g in
    select g.name, g.daily_task_chat_id chat, g.networking_thread_id thread
      from public.groups g
     where g.course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
       and g.daily_task_chat_id is not null and g.networking_thread_id is not null
       and exists (select 1 from public.profiles p where p.group_id = g.id and p.status = 'active' and p.archived_at is null)
     order by g.name
  loop
    perform public.ops_net_post(
      p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
      p_body       := jsonb_build_object('chat_id', _g.chat, 'message_thread_id', _g.thread, 'text', _text,
                                         'parse_mode', 'HTML', 'disable_web_page_preview', true),
      p_headers    := jsonb_build_object('Content-Type', 'application/json'),
      p_purpose    := 'module_4_announcement',
      p_timeout_ms := 10000);
    _posts := _posts || jsonb_build_object('group', _g.name, 'chat', _g.chat, 'thread', _g.thread);
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_announcement_posted', jsonb_build_object('marker', _marker, 'migration', '20261027133500', 'posts', _posts));
  return jsonb_build_object('status', 'posted', 'posts', _posts);
end
$function$;

revoke execute on function public.announce_module_4_groups() from public, anon, authenticated;
grant execute on function public.announce_module_4_groups() to service_role;

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _marker_dm constant text := 'module_4_dm_20261027';
  _uz constant text :=
    '🤖 <b>4-modul ochildi!</b>' || E'\n\n' ||
    'Endi «<b>Claude AI va Codex bilan avtomatlashtirish</b>» moduli sizga ochiq: <b>8 ta yangi dars</b> va <b>1 ta uyga vazifa</b>.' || E'\n\n' ||
    '▶️ Boshlash: botdagi «🚀 Ilovani ochish» tugmasi → 4-modul.' || E'\n\n' ||
    '📚 Har bir dars — <b>+20 ball</b>' || E'\n' ||
    '📝 Uyga vazifa — <b>+15 ball</b>' || E'\n' ||
    '⭐️ 9–10 baho — yana <b>+25 ball</b>' || E'\n\n' ||
    'Omad! Birinchi natijalaringizni kutamiz ⚙️🔥';
  _ru constant text :=
    '🤖 <b>Открыт 4-й модуль!</b>' || E'\n\n' ||
    'Модуль «<b>Claude AI va Codex bilan avtomatlashtirish</b>» (автоматизация с Claude AI и Codex) теперь открыт: <b>8 новых уроков</b> и <b>1 домашнее задание</b>.' || E'\n\n' ||
    '▶️ Как начать: кнопка «🚀 Ilovani ochish» в боте → 4-й модуль.' || E'\n\n' ||
    '📚 Каждый урок — <b>+20 баллов</b>' || E'\n' ||
    '📝 Домашнее задание — <b>+15 баллов</b>' || E'\n' ||
    '⭐️ Оценка 9–10 — ещё <b>+25 баллов</b>' || E'\n\n' ||
    'Удачи! Ждём ваши первые результаты ⚙️🔥';
  _en constant text :=
    '🤖 <b>Module 4 is open!</b>' || E'\n\n' ||
    'The module «<b>Claude AI va Codex bilan avtomatlashtirish</b>» (automation with Claude AI and Codex) is now open to you: <b>8 new lessons</b> and <b>1 homework task</b>.' || E'\n\n' ||
    '▶️ To start: the «🚀 Ilovani ochish» button in the bot → module 4.' || E'\n\n' ||
    '📚 Each lesson — <b>+20 points</b>' || E'\n' ||
    '📝 Homework — <b>+15 points</b>' || E'\n' ||
    '⭐️ A 9–10 grade — another <b>+25 points</b>' || E'\n\n' ||
    'Good luck! We can''t wait to see what you automate ⚙️🔥';
  _bid uuid;
  _n int;
  _local timestamp := now() at time zone 'Asia/Tashkent';
  _at date;
begin
  -- ── 1. DMs ──
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker_dm) then
    raise notice 'module 4 DMs already queued';
  elsif coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, no DMs queued';
  else
    insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                   button_label, button_url, mode, status, started_at)
    values (_course, null, null, _uz, _ru, _en, null, null, 'all', 'sending', now())
    returning id into _bid;

    insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
    select distinct on (p.telegram_id) _bid, p.id, p.telegram_id, now()
      from public.profiles p
      join public.groups g on g.id = p.group_id
     where g.course_id = _course
       and p.telegram_id is not null
       and p.telegram_write_access_at is not null
       and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r
                        where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
     order by p.telegram_id, p.created_at desc;
    get diagnostics _n = row_count;
    if _n > 300 then
      raise exception 'ABORT: % recipients — more than the whole 6.0 cohort', _n;
    end if;
    update public.broadcasts set total = _n,
           status = case when _n = 0 then 'done' else status end,
           finished_at = case when _n = 0 then now() end
     where id = _bid;
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'broadcast_created', jsonb_build_object(
      'broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n, 'has_image', false,
      'marker', _marker_dm, 'migration', '20261027133500'));
  end if;

  -- ── 2. group posts: now in daytime, else a one-shot at the next 08:30 Tashkent ──
  if extract(hour from _local) between 8 and 21 then
    perform public.announce_module_4_groups();
  else
    _at := case when _local::time < time '08:30' then _local::date else _local::date + 1 end;
    perform cron.unschedule(jobid) from cron.job where jobname = 'announce-module-4-groups';
    perform cron.schedule('announce-module-4-groups',
      format('30 3 %s %s *', extract(day from _at)::int, extract(month from _at)::int),   -- 03:30 UTC = 08:30 Tashkent
      $cmd$ select public.announce_module_4_groups() $cmd$);
    raise notice 'module 4 group posts scheduled for % 08:30 Tashkent', _at;
  end if;
end $$;
