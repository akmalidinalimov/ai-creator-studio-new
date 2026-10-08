-- Tell the Challenge 6.0 students about the new rating rule (owner, 2026-10-08: "can you send information about this").
--
-- The rule went live in 20261008084500 (09:24 UTC): every point earned so far is kept; from now on only watched
-- lessons (+20), homework (+15) and a 9–10 grade (+25) add to the rating; extra tasks (Instagram), questions/answers,
-- group photos/videos and daily logins no longer do.
--
-- 1. DM, in each student's language: the normal broadcast pipeline — one broadcasts row + one pending
--    broadcast_deliveries row per student of a course-6.0 group who pressed Start (the bot cannot DM the others),
--    active, not archived, not staff. The broadcast-drainer sends, defers quiet hours to 08:00 and records every
--    outcome. Respects the broadcast kill-switch.
-- 2. Group post (uz) in each group's «MUHIM E'LONLAR» topic, through ops_net_post (failures land in ops_http_failures,
--    attributed to 'rating_rules_announcement'). Topics as used by 20261006114500 / 20261007060500 / 20261007061000:
--    2-GURUH thread 123; 1-, 3-, 4-GURUH the General topic (renamed «MUHIM E'LONLAR», no thread id). 5- and 6-GURUH
--    have no students and are skipped.
-- Replay-safe: one audit marker per part.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _marker_dm constant text := 'rating_rules_20261008';
  _marker_grp constant text := 'rating_rules_groups_20261008';
  _uz constant text :=
    '📢 <b>Reyting tizimidagi o‘zgarish</b>' || E'\n\n' ||
    'Bugundan boshlab reytingga ball <b>faqat darslar va uyga vazifalar</b> uchun qo‘shiladi:' || E'\n\n' ||
    '📚 Darsni ko‘rib tugatish — <b>+20 ball</b>' || E'\n' ||
    '📝 Uyga vazifa topshirish — <b>+15 ball</b>' || E'\n' ||
    '⭐️ Vazifaga 9–10 baho — yana <b>+25 ball</b>' || E'\n\n' ||
    '✅ Shu paytgacha yig‘gan <b>barcha ballaringiz saqlanib qoladi</b>.' || E'\n\n' ||
    '❌ Qo‘shimcha vazifalar (Instagram), guruhdagi savol-javoblar, rasm/video tashlash va kunlik kirish endi ball bermaydi. Instagram ulash ham shart emas.' || E'\n\n' ||
    'Asosiy e’tibor — darslar va uyga vazifalarga. Vazifani sifatli bajaring: 9–10 baho qo‘shimcha +25 ball beradi! 💪';
  _ru constant text :=
    '📢 <b>Изменения в рейтинге</b>' || E'\n\n' ||
    'С сегодняшнего дня баллы в рейтинг добавляются <b>только за уроки и домашние задания</b>:' || E'\n\n' ||
    '📚 Просмотреть урок до конца — <b>+20 баллов</b>' || E'\n' ||
    '📝 Сдать домашнее задание — <b>+15 баллов</b>' || E'\n' ||
    '⭐️ Оценка 9–10 за задание — ещё <b>+25 баллов</b>' || E'\n\n' ||
    '✅ <b>Все баллы, набранные до сих пор, сохраняются</b>.' || E'\n\n' ||
    '❌ Дополнительные задания (Instagram), вопросы и ответы в группе, фото/видео в группе и ежедневный вход больше не дают баллов. Подключать Instagram тоже не нужно.' || E'\n\n' ||
    'Главное — уроки и домашние задания. Делайте задания качественно: оценка 9–10 даёт дополнительные +25 баллов! 💪';
  _en constant text :=
    '📢 <b>A change to the rating</b>' || E'\n\n' ||
    'From today, points are added to the rating <b>only for lessons and homework</b>:' || E'\n\n' ||
    '📚 Watch a lesson to the end — <b>+20 points</b>' || E'\n' ||
    '📝 Submit homework — <b>+15 points</b>' || E'\n' ||
    '⭐️ A 9–10 grade — another <b>+25 points</b>' || E'\n\n' ||
    '✅ <b>Every point you have earned so far stays</b>.' || E'\n\n' ||
    '❌ Extra tasks (Instagram), questions and answers in the group, photos/videos in the group and daily logins no longer earn points. You no longer need to connect Instagram either.' || E'\n\n' ||
    'Focus on the lessons and your homework. Do it well: a 9–10 grade brings an extra +25 points! 💪';
  _bid uuid;
  _n int;
  _tok text;
  _posts jsonb := '[]'::jsonb;
  _g record;
begin
  -- ── 1. DMs ──
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker_dm) then
    raise notice 'rating rules broadcast already queued';
  elsif coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, no DMs queued';
  else
    insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                   button_label, button_url, mode, status, started_at)
    values (_course, null, null, _uz, _ru, _en, null, null, 'all', 'sending', now())
    returning id into _bid;

    insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
    select _bid, p.id, p.telegram_id, now()
      from public.profiles p
      join public.groups g on g.id = p.group_id
     where g.course_id = _course
       and p.telegram_id is not null
       and p.telegram_write_access_at is not null
       and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r
                        where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'));
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
      'marker', _marker_dm, 'migration', '20261008093000'));
  end if;

  -- ── 2. group posts ──
  if exists (select 1 from public.admin_actions where action = 'group_announcement_posted' and details->>'marker' = _marker_grp) then
    raise notice 'rating rules group posts already sent';
    return;
  end if;
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    raise notice 'no bot token — no group posts';
    return;
  end if;

  for _g in
    select * from (values
      ('AC CHALLENGE | 1-GURUH', -1004440955972::bigint, null::bigint),
      ('AC CHALLENGE | 2-GURUH', -1004390902020::bigint, 123::bigint),
      ('AC CHALLENGE | 3-GURUH', -1003714608284::bigint, null::bigint),
      ('AC CHALLENGE | 4-GURUH', -1004463424516::bigint, null::bigint)
    ) v(name, chat, thread)
  loop
    perform public.ops_net_post(
      p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
      p_body       := jsonb_strip_nulls(jsonb_build_object('chat_id', _g.chat, 'message_thread_id', _g.thread, 'text', _uz,
                                                           'parse_mode', 'HTML', 'disable_web_page_preview', true)),
      p_headers    := jsonb_build_object('Content-Type', 'application/json'),
      p_purpose    := 'rating_rules_announcement',
      p_timeout_ms := 10000);
    _posts := _posts || jsonb_strip_nulls(jsonb_build_object('group', _g.name, 'chat', _g.chat, 'thread', _g.thread));
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_announcement_posted', jsonb_build_object(
    'marker', _marker_grp, 'migration', '20261008093000', 'posts', _posts));
end $$;
