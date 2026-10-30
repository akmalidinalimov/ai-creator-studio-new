-- AI CREATORS CHALLENGE 7.0 — platform setup (owner, 2026-10-30: "exactly like 6.0").
--
-- The course (a13b606e-…) was duplicated from 6.0 in the admin UI: 6 modules / 48 lessons / 9 homework copied
-- correctly. What the copy did not carry, and what 6.0 has:
--   1. a tier — «AC CHALLENGE 7.0», module_limit 1 (6.0 opened module 1 first, then raised it by hand / migration);
--      enforce_enrollment_tier_from_group refuses a tierless student enrollment, so no one can see every module
--   2. the BONUS module open to everyone (modules.always_open — lost in the copy)
--   3. the 4 groups, with the owner's Telegram invite links (the chat ids, topics and teachers come once the bot is an
--      admin in each chat — invite links carry no chat id)
--   4. the 7.0 course in the five settings that list 6.0:
--        homework_capture.course_ids             homework posted in the group topics is captured
--        homework_capture.auto_register_paid_…   a group member who writes to the bot gets a paid account
--        challenge.course_ids                    challenge engine scope (daily tasks, retro credit)
--        group_room.course_ids                   09:00 / 21:00 posts in each NETWORKING topic
--        rating_mode.content_only_course_ids     rating = lessons + homework (like 6.0 since 2026-10-08)
--      NOT teacher_room (its chat is «KURATORLAR 6.0»; 7.0 curators' chat to be decided).
-- The course stays UNPUBLISHED: publishing at launch is the owner's switch (it opens the content and the membership
-- check). Every step is idempotent (guards / set-union), so a replay changes nothing.

do $$
declare
  _c constant uuid := 'a13b606e-11d3-47e5-a2ff-6815790f7311';
  _tier uuid;
  _n int;
  _g record;
begin
  if not exists (select 1 from public.courses where id = _c and title = 'AI CREATORS CHALLENGE 7.0') then
    raise exception 'course 7.0 not found — refusing';
  end if;

  -- 1. tier
  select id into _tier from public.course_tiers where course_id = _c order by position limit 1;
  if _tier is null then
    insert into public.course_tiers (course_id, name, module_limit, position)
    values (_c, 'AC CHALLENGE 7.0', 1, 0) returning id into _tier;
  end if;

  -- 2. BONUS open to every enrolled student
  update public.modules set always_open = true
   where id = '0b49b7f1-ed23-4460-a50c-d9c6e7e56c3c' and course_id = _c and not always_open;

  -- 3. groups (by name; an existing one is left as it is)
  for _g in
    select * from (values
      ('AC CHALLENGE 7.0 | 1-GURUH', 'https://t.me/+dQfcCbSdsTFjNzI0'),
      ('AC CHALLENGE 7.0 | 2-GURUH', 'https://t.me/+lC28iJfX4xdiNzE8'),
      ('AC CHALLENGE 7.0 | 3-GURUH', 'https://t.me/+ll-7i0I9IC5kMTBk'),
      ('AC CHALLENGE 7.0 | 4-GURUH', 'https://t.me/+6j5OQGowBZw0YWE0')
    ) v(name, url)
  loop
    if not exists (select 1 from public.groups where course_id = _c and name = _g.name) then
      insert into public.groups (name, course_id, tier_id, telegram_group_url) values (_g.name, _c, _tier, _g.url);
    end if;
  end loop;

  -- 4. settings: add 7.0 to each list (set-union, so a replay or a hand edit never duplicates)
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
   where key in ('challenge', 'group_room');
  update public.platform_settings
     set value = jsonb_set(value, '{content_only_course_ids}', coalesce(value->'content_only_course_ids', '[]'::jsonb)
                           || case when coalesce(value->'content_only_course_ids', '[]'::jsonb) ? _c::text then '[]'::jsonb else to_jsonb(array[_c::text]) end),
         updated_at = now()
   where key = 'rating_mode';

  select count(*) into _n from public.groups where course_id = _c;
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'course_setup', jsonb_build_object('migration', '20261030142800', 'course', 'AI CREATORS CHALLENGE 7.0',
         'course_id', _c, 'tier_id', _tier, 'groups', _n, 'bonus_always_open', true,
         'settings', jsonb_build_array('homework_capture', 'homework_capture.auto_register_paid', 'challenge', 'group_room', 'rating_mode'))
   where not exists (select 1 from public.admin_actions where action = 'course_setup' and details->>'course_id' = _c::text);
end $$;
