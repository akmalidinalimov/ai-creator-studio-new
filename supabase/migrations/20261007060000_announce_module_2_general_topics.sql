-- Module 2 announcement for 1-, 3- and 5-GURUH (owner, 2026-10-07). 20261006114500 posted it in 2-GURUH's «MUHIM
-- E'LONLAR» topic (thread 123) and left the other groups for when their topics were known.
--
-- The owner posted "..." in each group's «MUHIM E'LONLAR» this morning. In 1-, 3- and 5-GURUH those messages arrived
-- with NO message_thread_id — the group's General topic (renamed «MUHIM E'LONLAR» there), which takes a post without a
-- thread id. Those exact messages are pinned below and re-checked in webhook_inbox before anything is sent (a renamed
-- or moved chat posts nothing). 4- and 6-GURUH: the bot received no such message — not posted here.
--
-- Same text as 2-GURUH got. No DMs (the students were DM'd by 20261006114500). Sent through ops_net_post (failures land
-- in ops_http_failures, attributed to 'module2_announcement'). Replay-safe: one audit marker.

do $$
declare
  _marker constant text := 'module_2_open_general_20261007';
  _tok text;
  _posts jsonb := '[]'::jsonb;
  _skipped jsonb := '[]'::jsonb;
  _g record;
  _group_text constant text :=
    '🎉 <b>2-modul ochildi!</b>' || E'\n\n' ||
    '«<b>AI bilan professional rasm qilish</b>» — platformada <b>11 ta yangi dars</b>.' || E'\n\n' ||
    'Chorshanba kungi qoʻshimcha vazifa shu modul asosida boʻladi — darslarni oldindan koʻrib chiqing! 💪';
begin
  if exists (select 1 from public.admin_actions where action = 'group_announcement_posted' and details->>'marker' = _marker) then
    raise notice 'module 2 general-topic announcement already posted';
    return;
  end if;

  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    raise notice 'no bot token — nothing posted';
    return;
  end if;

  for _g in
    select * from (values
      ('AC CHALLENGE | 1-GURUH', -1004440955972::bigint, 3562::bigint),
      ('AC CHALLENGE | 3-GURUH', -1003714608284::bigint, 2929::bigint),
      ('AC CHALLENGE | 5-GURUH', -1004396568866::bigint, 29::bigint)
    ) v(name, chat, owner_msg)
  loop
    -- the owner's "..." must be there, in that chat, in the General topic (no thread id)
    if not exists (select 1 from public.webhook_inbox w
                    where w.chat_id = _g.chat and w.message_id = _g.owner_msg and w.message_thread_id is null
                      and w.received_at > '2026-10-07 05:50+00' and w.text_preview like '..%') then
      _skipped := _skipped || jsonb_build_object('group', _g.name, 'reason', 'owner_marker_not_found');
      continue;
    end if;
    perform public.ops_net_post(
      p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
      p_body       := jsonb_build_object('chat_id', _g.chat, 'text', _group_text,
                                         'parse_mode', 'HTML', 'disable_web_page_preview', true),
      p_headers    := jsonb_build_object('Content-Type', 'application/json'),
      p_purpose    := 'module2_announcement',
      p_timeout_ms := 10000);
    _posts := _posts || jsonb_build_object('group', _g.name, 'chat', _g.chat, 'topic', 'general');
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_announcement_posted', jsonb_build_object(
    'marker', _marker, 'migration', '20261007060000', 'posts', _posts, 'skipped', _skipped,
    'not_posted', jsonb_build_array('4-GURUH', '6-GURUH')));
end $$;
