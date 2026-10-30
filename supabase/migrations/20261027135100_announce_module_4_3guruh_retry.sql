-- Retry: the module 4 announcement for 3-GURUH (2026-10-27).
--
-- 20261027133500 posted it in the NETWORKING topic of 1-, 2-, 3- and 4-GURUH. Telegram confirmed 1-, 2- and 4-GURUH
-- (HTTP 200, net._http_response 577122/577123/577125); the 3-GURUH request timed out in the TCP/TLS handshake
-- (577124: handshake 9.996 s, request time 0, ops_http_failures 'timeout') — it never reached Telegram. Same class as
-- the 2026-10-07 module-2 retry (20261007061000).
--
-- Posts once more, same text, same NETWORKING topic (thread 4), with a 30 s timeout. Guard: no 200 response for 3-GURUH
-- carries the announcement yet. Replay-safe: its own audit marker.

do $$
declare
  _marker constant text := 'module_4_groups_3guruh_retry_20261027';
  _chat constant bigint := -1003714608284;
  _thread constant int := 4;
  _tok text;
  _text constant text :=
    '🤖 <b>4-modul ochildi!</b>' || E'\n\n' ||
    'Endi «<b>Claude AI va Codex bilan avtomatlashtirish</b>» moduli hammaga ochiq: <b>8 ta yangi dars</b> va <b>1 ta uyga vazifa</b>.' || E'\n\n' ||
    '▶️ Boshlash: botdagi «🚀 Ilovani ochish» tugmasi → 4-modul.' || E'\n\n' ||
    '📚 Har bir dars — <b>+20 ball</b>' || E'\n' ||
    '📝 Uyga vazifa — <b>+15 ball</b>' || E'\n' ||
    '⭐️ 9–10 baho — yana <b>+25 ball</b>' || E'\n\n' ||
    'Ishingizni AI bilan avtomatlashtirishni boshlaymiz — natijalaringizni shu yerda kutamiz! ⚙️🔥';
begin
  if exists (select 1 from public.admin_actions where action = 'group_announcement_posted' and details->>'marker' = _marker) then
    raise notice '3-GURUH retry already posted';
    return;
  end if;
  -- a successful earlier send would have come back with the text in a 200 response
  if exists (select 1 from net._http_response r
              where r.created > '2026-10-27 13:40+00' and r.status_code = 200
                and r.content like '%4-modul ochildi%' and r.content like '%-1003714608284%') then
    raise notice '3-GURUH already got the announcement — not posting twice';
    return;
  end if;
  -- the NETWORKING topic is still the one the original post targeted
  if not exists (select 1 from public.groups where daily_task_chat_id = _chat and networking_thread_id = _thread) then
    raise notice '3-GURUH NETWORKING topic changed — not posting';
    return;
  end if;

  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    raise notice 'no bot token — nothing posted';
    return;
  end if;

  perform public.ops_net_post(
    p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
    p_body       := jsonb_build_object('chat_id', _chat, 'message_thread_id', _thread, 'text', _text,
                                       'parse_mode', 'HTML', 'disable_web_page_preview', true),
    p_headers    := jsonb_build_object('Content-Type', 'application/json'),
    p_purpose    := 'module_4_announcement',
    p_timeout_ms := 30000);

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_announcement_posted', jsonb_build_object(
    'marker', _marker, 'migration', '20261027135100', 'posts', jsonb_build_array(
      jsonb_build_object('group', 'AC CHALLENGE | 3-GURUH', 'chat', _chat, 'thread', _thread, 'retry_of', '20261027133500'))));
end $$;
