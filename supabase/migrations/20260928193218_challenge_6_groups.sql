-- Challenge 6.0: register the four "AC CHALLENGE | N-GURUH" Telegram groups as platform groups.
--
-- The owner created the four forum supergroups on 2026-09-28 and added the bot as administrator
-- (webhook_inbox my_chat_member, all four). The platform recognises a group by the chat id inside
-- homework_topic_url (https://t.me/c/<id>/<thread>): the bot's membership gate, homework capture and
-- the challenge reconciler all key on it. Homework topic links are the owner's, 2026-09-28.
--
--   1-GURUH  chat -1004440955972  homework thread 3
--   2-GURUH  chat -1004390902020  homework thread 6
--   3-GURUH  chat -1003714608284  homework thread 5
--   4-GURUH  chat -1004463424516  homework thread 7
--
-- Also: each group's weekly board posts in the General topic ("1"), exactly like the 5.0 groups.
-- Not set here (owner, Admin -> Guruhlar): teacher, invite link (telegram_group_url).
-- No tier: 6.0 has no tiers, so tier_id stays null = every module.
-- Replay-safe: groups insert on the (lower(name), course_id) unique index; topics are a jsonb merge.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _n int;
  _bad int;
begin
  if not exists (select 1 from public.courses where id = _course and title = 'AI CREATORS CHALLENGE 6.0') then
    raise exception 'challenge 6.0 course % not found (or renamed)', _course;
  end if;

  insert into public.groups (name, course_id, homework_topic_url)
  values ('AC CHALLENGE | 1-GURUH', _course, 'https://t.me/c/4440955972/3'),
         ('AC CHALLENGE | 2-GURUH', _course, 'https://t.me/c/4390902020/6'),
         ('AC CHALLENGE | 3-GURUH', _course, 'https://t.me/c/3714608284/5'),
         ('AC CHALLENGE | 4-GURUH', _course, 'https://t.me/c/4463424516/7')
  on conflict (lower(name), course_id) do nothing;

  -- Assert the result: four groups, each with the thread id the trigger extracts from its URL.
  select count(*) into _n from public.groups where course_id = _course and name like 'AC CHALLENGE | _-GURUH';
  if _n <> 4 then
    raise exception 'expected 4 challenge groups, found %', _n;
  end if;
  select count(*) into _bad
    from public.groups g
    join (values ('AC CHALLENGE | 1-GURUH', 'https://t.me/c/4440955972/3', 3::bigint),
                 ('AC CHALLENGE | 2-GURUH', 'https://t.me/c/4390902020/6', 6::bigint),
                 ('AC CHALLENGE | 3-GURUH', 'https://t.me/c/3714608284/5', 5::bigint),
                 ('AC CHALLENGE | 4-GURUH', 'https://t.me/c/4463424516/7', 7::bigint)) v(nm, url, thread)
      on g.name = v.nm and g.course_id = _course
   where g.homework_topic_url is distinct from v.url
      or g.homework_topic_id is distinct from v.thread
      or g.tier_id is not null;
  if _bad > 0 then
    raise exception '% challenge group(s) not configured as intended', _bad;
  end if;

  -- Weekly board: General topic, merged into the existing map (other groups' entries untouched).
  update public.platform_settings
     set value = jsonb_set(value, '{topics}',
                   coalesce(value->'topics', '{}'::jsonb)
                   || (select jsonb_object_agg(g.id::text, '1')
                         from public.groups g
                        where g.course_id = _course and g.name like 'AC CHALLENGE | _-GURUH')),
         updated_at = now()
   where key = 'group_weekly_board';
  if not found then
    raise exception 'platform_settings.group_weekly_board row missing';
  end if;
  select count(*) into _n
    from public.groups g, public.platform_settings s
   where s.key = 'group_weekly_board' and g.course_id = _course
     and s.value->'topics'->>(g.id::text) = '1';
  if _n <> 4 then
    raise exception 'expected 4 weekly-board topics for challenge groups, found %', _n;
  end if;

  if not exists (select 1 from public.admin_actions where action = 'challenge_groups_registered') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_groups_registered', jsonb_build_object(
      'course_id', _course,
      'groups', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'thread', homework_topic_id) order by name)
                   from public.groups where course_id = _course),
      'at', now()));
  end if;
end $$;
