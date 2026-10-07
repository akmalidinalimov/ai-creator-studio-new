-- Retry: the module 2 announcement for 4-GURUH (2026-10-07).
--
-- 20261007060500 posted it in 1-, 3-, 4- and 5-GURUH. Telegram confirmed 1-, 3- and 5-GURUH (HTTP 200); the 4-GURUH
-- request timed out in the TCP/TLS handshake (net._http_response 451700: handshake 9.99 s, request time 0) — it never
-- reached Telegram. Evidence it was NOT posted: the next message in 4-GURUH after the owner's marker 2074 is 2075, a
-- student's (a bot post would have taken 2075).
--
-- Posts once more, General topic (no thread id), with a 30 s timeout. Guards: the owner's marker 2074 is still in
-- webhook_inbox, and no message in 4-GURUH carries the announcement yet. Replay-safe: its own audit marker.

do $$
declare
  _marker constant text := 'module_2_open_4guruh_retry_20261007';
  _chat constant bigint := -1004463424516;
  _tok text;
  _group_text constant text :=
    '🎉 <b>2-modul ochildi!</b>' || E'\n\n' ||
    '«<b>AI bilan professional rasm qilish</b>» — platformada <b>11 ta yangi dars</b>.' || E'\n\n' ||
    'Chorshanba kungi qoʻshimcha vazifa shu modul asosida boʻladi — darslarni oldindan koʻrib chiqing! 💪';
begin
  if exists (select 1 from public.admin_actions where action = 'group_announcement_posted' and details->>'marker' = _marker) then
    raise notice '4-GURUH retry already posted';
    return;
  end if;
  if not exists (select 1 from public.webhook_inbox w
                  where w.chat_id = _chat and w.message_id = 2074 and w.message_thread_id is null and w.text_preview like '..%') then
    raise notice 'the owner''s marker in 4-GURUH is gone — not posting';
    return;
  end if;
  -- a successful earlier send would have come back with the text in a 200 response
  if exists (select 1 from net._http_response r
              where r.created > '2026-10-07 06:00+00' and r.status_code = 200
                and r.content like '%2-modul ochildi%' and r.content like '%-1004463424516%') then
    raise notice '4-GURUH already got the announcement — not posting twice';
    return;
  end if;

  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    raise notice 'no bot token — nothing posted';
    return;
  end if;

  perform public.ops_net_post(
    p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
    p_body       := jsonb_build_object('chat_id', _chat, 'text', _group_text, 'parse_mode', 'HTML', 'disable_web_page_preview', true),
    p_headers    := jsonb_build_object('Content-Type', 'application/json'),
    p_purpose    := 'module2_announcement',
    p_timeout_ms := 30000);

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_announcement_posted', jsonb_build_object(
    'marker', _marker, 'migration', '20261007061000', 'posts', jsonb_build_array(
      jsonb_build_object('group', 'AC CHALLENGE | 4-GURUH', 'chat', _chat, 'topic', 'general', 'retry_of', '20261007060500'))));
end $$;
