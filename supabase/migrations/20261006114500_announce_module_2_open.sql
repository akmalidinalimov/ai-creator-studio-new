-- Announce that module 2 is open (owner, 2026-10-06; opened by 20261006053000).
--
-- 1. DM to every Challenge 6.0 student through the normal broadcast pipeline (one broadcasts row + one pending
--    broadcast_deliveries row per student; the drainer sends uz / ru / en, defers quiet hours, records every outcome).
--    Audience as before: a course-6.0 group, telegram_write_access_at set (the bot can DM them), active, not archived,
--    not staff. Respects the broadcast kill-switch.
-- 2. A post in the group's «MUHIM E'LONLAR» topic, for every group whose topic the bot has seen: today only
--    2-GURUH (thread 123, from its forum_topic_created service message). The other groups' topic ids are unknown to the
--    bot (no message from those topics in webhook_inbox) and are posted once the owner sends the links. Sent through
--    ops_net_post (every failure lands in ops_http_failures, attributed to 'module2_announcement').
-- Replay-safe: one audit marker for both parts.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _marker constant text := 'module_2_open_20261006';
  _bid uuid;
  _n int;
  _tok text;
  _posts jsonb := '[]'::jsonb;
  _g record;
  _group_text constant text :=
    '🎉 <b>2-modul ochildi!</b>' || E'\n\n' ||
    '«<b>AI bilan professional rasm qilish</b>» — platformada <b>11 ta yangi dars</b>.' || E'\n\n' ||
    'Chorshanba kungi qoʻshimcha vazifa shu modul asosida boʻladi — darslarni oldindan koʻrib chiqing! 💪';
begin
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker) then
    raise notice 'module 2 announcement already sent';
    return;
  end if;

  -- 1. the DMs
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) then
    insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                   button_label, button_url, mode, status, started_at)
    values (_course, null, null,
      '🎉 <b>2-modul ochildi!</b>' || E'\n\n' ||
      '«<b>AI bilan professional rasm qilish</b>» — platformada <b>11 ta yangi dars</b>.' || E'\n\n' ||
      'Chorshanba kungi qoʻshimcha vazifa shu modul asosida boʻladi — darslarni oldindan koʻrib chiqing! 💪',
      '🎉 <b>Открыт 2-й модуль!</b>' || E'\n\n' ||
      '«<b>Профессиональные изображения с AI</b>» — <b>11 новых уроков</b> на платформе.' || E'\n\n' ||
      'Дополнительное задание в среду будет по этому модулю — посмотрите уроки заранее! 💪',
      '🎉 <b>Module 2 is open!</b>' || E'\n\n' ||
      '«<b>Professional images with AI</b>» — <b>11 new lessons</b> on the platform.' || E'\n\n' ||
      'Wednesday''s extra task is based on this module — watch the lessons beforehand! 💪',
      null, null, 'all', 'sending', now())
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
  else
    raise notice 'broadcast kill-switch is off, no DMs queued';
  end if;

  -- 2. the «MUHIM E'LONLAR» topic posts (groups whose topic the bot has seen)
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') <> '' then
    for _g in
      select * from (values ('AC CHALLENGE | 2-GURUH', -1004390902020::bigint, 123::bigint)) v(name, chat, thread)
    loop
      -- the topic must still be the one the bot saw being created as «MUHIM E'LONLAR»
      continue when not exists (select 1 from public.webhook_inbox w
                                 where w.chat_id = _g.chat
                                   and (w.raw_update->'message'->>'message_id')::bigint = _g.thread
                                   and w.raw_update->'message'->'forum_topic_created'->>'name' ilike 'MUHIM E%LONLAR');
      perform public.ops_net_post(
        p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        p_body       := jsonb_build_object('chat_id', _g.chat, 'message_thread_id', _g.thread, 'text', _group_text,
                                           'parse_mode', 'HTML', 'disable_web_page_preview', true),
        p_headers    := jsonb_build_object('Content-Type', 'application/json'),
        p_purpose    := 'module2_announcement',
        p_timeout_ms := 10000);
      _posts := _posts || jsonb_build_object('group', _g.name, 'chat', _g.chat, 'thread', _g.thread);
    end loop;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'broadcast_created', jsonb_build_object(
    'broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n, 'has_image', false,
    'marker', _marker, 'migration', '20261006114500', 'group_topic_posts', _posts,
    'group_topics_unknown', jsonb_build_array('1-GURUH', '3-GURUH', '4-GURUH', '5-GURUH', '6-GURUH')));
end $$;
