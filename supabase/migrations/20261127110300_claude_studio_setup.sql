-- CLAUDE STUDIO — platform setup, the 7.0 way (owner, 2026-11-27: "everyone who joins the channel and who is a member
-- of the group can watch … in the Telegram bot for Claude Studio"; "build and merge it").
--
-- Incident: the course (36e79750-…) was created in the admin UI and published on 2026-11-23 with NO group, NO tier and
-- no Telegram chats registered. The bot's membership gate (resolveMembershipGroup) only knows chats that a group or a
-- course channel points at, so every channel/group member without an account was told "Bu bot faqat AI Creators
-- talabalari uchun." — 13 people had joined the two chats by 11-27, 11 of them with no account, 5 of those had already
-- written to the bot and been refused (e.g. @yulduztulkunovna, /start /dars /vazifalar on 11-26 14:18 UTC).
--
-- Chats (from webhook_inbox: my_chat_member = administrator, and the owner's "..." markers in each topic):
--   channel «CLAUDE STUDIO | DARSLIKLAR»   -1004450754958
--   group   «CLAUDE STUDIO | 1 - GURUH»    -1004481103852   UYGA VAZIFA 8, KURATORGA SAVOLLAR 4, NETWORKING 6
--
-- What this sets up (every part mirrors 7.0: 20261030142800 / 20261030145000 / 20261030153100 / 20261030154200):
--   1. a tier «CLAUDE STUDIO», module_limit 1. NOT NULL ("every module"): the bot's module ladder
--      (autoRegisterLadderLimit) refuses an unbounded tier and would register every member as a 'provisional' trial
--      account with NO video. The course has one module today; the owner raises the limit in Admin → Kurslar → Tariflar
--      when module 2 is published, exactly as for 6.0/7.0.
--   2. the group «CLAUDE STUDIO | 1 - GURUH» with its invite link, homework topic (its /c/ link is the chat id the
--      membership gate probes), questions and NETWORKING threads
--   3. the holding group «CLAUDE STUDIO | KANAL» (no chat of its own) where a channel-only member is registered; they are
--      moved into the real group automatically once seen there (course_membership_place)
--   4. the course: channel chat id + invite link, channel_group_id, membership_required (leave both chats → locked after
--      the 24 h grace; inert until course_membership_ready, which this migration makes true)
--   5. the settings 7.0 is in: homework_capture.course_ids + auto_register_paid_course_ids (a member who writes to the
--      bot gets a normal account on the tier), group_room (09:00 / 21:00 posts in NETWORKING), rating_mode
--      content_only, group_weekly_board topic "1" for the real group. NOT challenge (retired; its team board would mix
--      cohorts) and NOT teacher_room (no curators' chat for this course yet).
-- No teacher is assigned (owner's to-do): teacherless-homework-watchdog will say so if homework arrives before one is.
-- Guarded and idempotent: refuses if the course is not «CLAUDE STUDIO»; existing rows / hand-set values are kept;
-- settings are set-unions.

do $$
declare
  _c constant uuid := '36e79750-6dd6-4f1d-ac6f-c74c7237ec86';
  _tier uuid;
  _grp uuid;
  _hold uuid;
begin
  if not exists (select 1 from public.courses where id = _c and title = 'CLAUDE STUDIO') then
    raise exception 'course CLAUDE STUDIO not found — refusing';
  end if;

  -- 1. tier
  select id into _tier from public.course_tiers where course_id = _c order by position limit 1;
  if _tier is null then
    insert into public.course_tiers (course_id, name, module_limit, position)
    values (_c, 'CLAUDE STUDIO', 1, 0) returning id into _tier;
  end if;

  -- 2. the real group
  select id into _grp from public.groups where course_id = _c and name = 'CLAUDE STUDIO | 1 - GURUH';
  if _grp is null then
    insert into public.groups (name, course_id, tier_id, telegram_group_url, homework_topic_url,
                               questions_thread_id, networking_thread_id)
    values ('CLAUDE STUDIO | 1 - GURUH', _c, _tier, 'https://t.me/+g20SHB_x7vQ3MWNk',
            'https://t.me/c/4481103852/8', 4, 6)
    returning id into _grp;
  else
    update public.groups
       set tier_id              = coalesce(tier_id, _tier),
           telegram_group_url   = coalesce(telegram_group_url, 'https://t.me/+g20SHB_x7vQ3MWNk'),
           homework_topic_url   = coalesce(homework_topic_url, 'https://t.me/c/4481103852/8'),
           questions_thread_id  = coalesce(questions_thread_id, 4),
           networking_thread_id = coalesce(networking_thread_id, 6)
     where id = _grp;
  end if;

  -- 3. the holding group for channel-only members
  select id into _hold from public.groups where course_id = _c and name = 'CLAUDE STUDIO | KANAL';
  if _hold is null then
    insert into public.groups (name, course_id, tier_id) values ('CLAUDE STUDIO | KANAL', _c, _tier) returning id into _hold;
  end if;

  -- 4. the channel + membership
  update public.courses
     set telegram_channel_chat_id = coalesce(telegram_channel_chat_id, -1004450754958),
         telegram_channel_url     = coalesce(telegram_channel_url, 'https://t.me/+IX3c6eeeoA02ZWI0'),
         channel_group_id         = coalesce(channel_group_id, _hold),
         membership_required      = true
   where id = _c;

  -- 5. settings (set-union: a replay or a hand edit never duplicates)
  update public.platform_settings
     set value = jsonb_set(jsonb_set(value,
           '{course_ids}', coalesce(value->'course_ids', '[]'::jsonb)
                           || case when coalesce(value->'course_ids', '[]'::jsonb) ? _c::text then '[]'::jsonb else to_jsonb(array[_c::text]) end),
           '{auto_register_paid_course_ids}', coalesce(value->'auto_register_paid_course_ids', '[]'::jsonb)
                           || case when coalesce(value->'auto_register_paid_course_ids', '[]'::jsonb) ? _c::text then '[]'::jsonb else to_jsonb(array[_c::text]) end),
         updated_at = now()
   where key = 'homework_capture';
  update public.platform_settings
     set value = jsonb_set(value, '{course_ids}', coalesce(value->'course_ids', '[]'::jsonb)
                           || case when coalesce(value->'course_ids', '[]'::jsonb) ? _c::text then '[]'::jsonb else to_jsonb(array[_c::text]) end),
         updated_at = now()
   where key = 'group_room';
  update public.platform_settings
     set value = jsonb_set(value, '{content_only_course_ids}', coalesce(value->'content_only_course_ids', '[]'::jsonb)
                           || case when coalesce(value->'content_only_course_ids', '[]'::jsonb) ? _c::text then '[]'::jsonb else to_jsonb(array[_c::text]) end),
         updated_at = now()
   where key = 'rating_mode';
  update public.platform_settings
     set value = jsonb_set(value, '{topics}', jsonb_build_object(_grp::text, '1') || coalesce(value->'topics', '{}'::jsonb)),
         updated_at = now()
   where key = 'group_weekly_board';

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'course_setup', jsonb_build_object('migration', '20261127110300', 'course', 'CLAUDE STUDIO',
         'course_id', _c, 'tier_id', _tier, 'group_id', _grp, 'holding_group_id', _hold, 'channel', -1004450754958,
         'ready', public.course_membership_ready(_c),
         'settings', jsonb_build_array('homework_capture', 'homework_capture.auto_register_paid', 'group_room',
                                       'rating_mode', 'group_weekly_board'))
   where not exists (select 1 from public.admin_actions where action = 'course_setup' and details->>'course_id' = _c::text);
end $$;
