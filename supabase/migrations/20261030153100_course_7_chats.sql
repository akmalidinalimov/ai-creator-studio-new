-- 7.0: connect the Telegram chats (owner, 2026-10-30: bot made admin everywhere, "..." posted in every topic).
--
-- From webhook_inbox (my_chat_member: bot = administrator; the owner's "..." markers, each with its forum topic name):
--   channel «AC CHALLENGE 7.0 | DARSLIKLAR»  -1003974685645
--   group   chat              UYGA VAZIFA  KURATORGA SAVOLLAR  NETWORKING
--   1-GURUH -1004483114241    8            4                   6
--   2-GURUH -1004418473964    8            4                   6
--   3-GURUH -1004395060189    8            4                   6
--   4-GURUH -1004364240458    9            4                   7
-- homework_topic_url (t.me/c/<chat>/<topic>) gives each group its chat id (group_telegram_chat_id, the membership check)
-- and its homework topic; questions_thread_id / networking_thread_id the inbox and the group posts.
-- No «KUNLIK VAZIFALAR» topic exists yet: daily_task_topic_url stays empty — the daily challenge tasks and the
-- 09:00 / 21:00 group posts (which read daily_task_chat_id) wait for it.
-- Guarded: only the four 7.0 groups by name, only empty fields are filled (a value set by hand in admin is kept).

do $$
declare
  _c constant uuid := 'a13b606e-11d3-47e5-a2ff-6815790f7311';
  _g record;
  _n int := 0;
begin
  update public.courses set telegram_channel_chat_id = -1003974685645
   where id = _c and telegram_channel_chat_id is null;

  for _g in
    select * from (values
      ('AC CHALLENGE 7.0 | 1-GURUH', '4483114241', 8, 4, 6),
      ('AC CHALLENGE 7.0 | 2-GURUH', '4418473964', 8, 4, 6),
      ('AC CHALLENGE 7.0 | 3-GURUH', '4395060189', 8, 4, 6),
      ('AC CHALLENGE 7.0 | 4-GURUH', '4364240458', 9, 4, 7)
    ) v(name, chat, hw, q, net)
  loop
    update public.groups
       set homework_topic_url   = coalesce(homework_topic_url, 'https://t.me/c/' || _g.chat || '/' || _g.hw),
           questions_thread_id  = coalesce(questions_thread_id, _g.q),
           networking_thread_id = coalesce(networking_thread_id, _g.net)
     where course_id = _c and name = _g.name;
    _n := _n + 1;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'course_chats_connected', jsonb_build_object('migration', '20261030153100', 'course_id', _c,
          'channel', -1003974685645, 'groups', _n, 'ready', public.course_membership_ready(_c)));
end $$;
