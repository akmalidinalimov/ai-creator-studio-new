-- Challenge 6.0: register "AC CHALLENGE | 5-GURUH" and "AC CHALLENGE | 6-GURUH", and pin every Challenge group's
-- homework ("UYGA VAZIFA") and daily-task ("KUNLIK VAZIFALAR") topics.
--
-- Evidence (webhook_inbox, 2026-09-30 13:01-13:04 UTC): the owner typed "UYGA VAZIFA" and "KUNLIK VAZIFALAR" in
-- the matching topic of each group; each message's reply_to_message.forum_topic_created.name identifies the
-- topic it was posted in (the topic's own name, so a word typed in the wrong topic cannot mislead it). The bot is
-- administrator in both new chats (my_chat_member, 2026-09-30 11:41 UTC).
--
--   group     chat              UYGA VAZIFA   KUNLIK VAZIFALAR
--   1-GURUH   -1004440955972    3             144   (already on the platform: #207, #220)
--   2-GURUH   -1004390902020    6             99    (already)
--   3-GURUH   -1003714608284    5             38    (already)
--   4-GURUH   -1004463424516    7             12    (already)
--   5-GURUH   -1004396568866    4             10    NEW
--   6-GURUH   -1004423411304    6             10    NEW (Telegram title is misspelled "CHALLANGE"; the platform
--                                                      name uses the correct spelling, like the other five)
--
-- Like #207: course 6.0, no tier (= every module), weekly board in the General topic ("1"), no teacher (owner
-- assigns in Admin -> Guruhlar). trg_groups_extract_homework_topic_id and trg_groups_extract_daily_task_topic
-- derive the ids/chat from the URLs and reject a wrong chat, General, or homework == daily.
-- Replay-safe: insert on the (lower(name), course_id) unique index; the board-topic merge is idempotent; the
-- assertions below re-check ALL SIX groups against the table above, so a drifted existing row fails loudly.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _bad int;
  _n int;
begin
  if not exists (select 1 from public.courses where id = _course and title = 'AI CREATORS CHALLENGE 6.0') then
    raise exception 'challenge 6.0 course % not found (or renamed)', _course;
  end if;

  insert into public.groups (name, course_id, homework_topic_url, daily_task_topic_url)
  values ('AC CHALLENGE | 5-GURUH', _course, 'https://t.me/c/4396568866/4', 'https://t.me/c/4396568866/10'),
         ('AC CHALLENGE | 6-GURUH', _course, 'https://t.me/c/4423411304/6', 'https://t.me/c/4423411304/10')
  on conflict (lower(name), course_id) do nothing;

  -- Every Challenge group, exactly as the table in the header says.
  with expected(nm, hw_url, hw_id, daily_url, daily_id, chat) as (values
    ('AC CHALLENGE | 1-GURUH', 'https://t.me/c/4440955972/3', 3::bigint, 'https://t.me/c/4440955972/144', 144::bigint, -1004440955972::bigint),
    ('AC CHALLENGE | 2-GURUH', 'https://t.me/c/4390902020/6', 6, 'https://t.me/c/4390902020/99', 99, -1004390902020),
    ('AC CHALLENGE | 3-GURUH', 'https://t.me/c/3714608284/5', 5, 'https://t.me/c/3714608284/38', 38, -1003714608284),
    ('AC CHALLENGE | 4-GURUH', 'https://t.me/c/4463424516/7', 7, 'https://t.me/c/4463424516/12', 12, -1004463424516),
    ('AC CHALLENGE | 5-GURUH', 'https://t.me/c/4396568866/4', 4, 'https://t.me/c/4396568866/10', 10, -1004396568866),
    ('AC CHALLENGE | 6-GURUH', 'https://t.me/c/4423411304/6', 6, 'https://t.me/c/4423411304/10', 10, -1004423411304))
  select count(*) into _bad
    from expected e
    left join public.groups g on g.name = e.nm and g.course_id = _course
   where g.id is null
      or g.homework_topic_url is distinct from e.hw_url
      or g.homework_topic_id is distinct from e.hw_id
      or g.daily_task_topic_url is distinct from e.daily_url
      or g.daily_task_topic_id is distinct from e.daily_id
      or g.daily_task_chat_id is distinct from e.chat
      or g.tier_id is not null
      or public.group_telegram_chat_id(g.id) is distinct from e.chat;
  if _bad > 0 then
    raise exception '% challenge group(s) do not match the expected homework/daily topics', _bad;
  end if;
  select count(*) into _n from public.groups where course_id = _course;
  if _n <> 6 then
    raise exception 'expected exactly 6 challenge groups, found %', _n;
  end if;

  -- Weekly board in the General topic for the two new groups (the other four already have it).
  update public.platform_settings
     set value = jsonb_set(value, '{topics}',
                   coalesce(value->'topics', '{}'::jsonb)
                   || (select jsonb_object_agg(g.id::text, '1')
                         from public.groups g
                        where g.course_id = _course and g.name in ('AC CHALLENGE | 5-GURUH', 'AC CHALLENGE | 6-GURUH'))),
         updated_at = now()
   where key = 'group_weekly_board';
  if not found then
    raise exception 'platform_settings.group_weekly_board row missing';
  end if;
  select count(*) into _n
    from public.groups g, public.platform_settings s
   where s.key = 'group_weekly_board' and g.course_id = _course
     and s.value->'topics'->>(g.id::text) = '1';
  if _n <> 6 then
    raise exception 'expected 6 weekly-board topics for challenge groups, found %', _n;
  end if;

  if not exists (select 1 from public.admin_actions where action = 'challenge_groups_5_6_registered') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_groups_5_6_registered', jsonb_build_object(
      'course_id', _course,
      'groups', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'homework', homework_topic_id,
                                                     'daily', daily_task_topic_id) order by name)
                   from public.groups where course_id = _course),
      'at', now()));
  end if;
end $$;
