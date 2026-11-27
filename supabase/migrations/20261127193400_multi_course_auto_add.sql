-- Multi-course students, PR 3a: automatic adding (owner, 2026-11-27). Only for the courses on an explicit list —
-- the owner did not choose between "any course" and "new courses only", so the cautious one: a course is
-- auto-added only when it is listed in platform_settings 'multi_course'.auto_add_course_ids. Starts with
-- CLAUDE STUDIO alone; older cohorts (5.0 / 6.0 / 7.0) are never added automatically (3 students of 6.0 sit in
-- 5.0 / 7.0 chats today — they stay as they are, an admin adds them by hand if wanted).
--
--   1. platform_settings 'multi_course' = {"auto_add_course_ids": ["<CLAUDE STUDIO>"]}   (kill-switch: empty list)
--   2. auto_add_course_on_join(telegram_id, chat_id): called by the bot on a chat_member JOIN. A registered, active,
--      non-staff student who joins a chat of a listed, published course that is not theirs yet gets it as a second
--      course through add_student_course_group (audited, source 'telegram_join'):
--        a real group's chat (/c/<id>/ of its topic / group link, or daily_task_chat_id) → that group
--        the course's channel → its holding group (channel_group_id)
--      A student whose only place in the course is its holding group and who joins a real group's chat is moved
--      into that group ('changed'). Their MAIN course is never touched (that is a move; course_membership_place
--      handles a main holding group). Event-driven: no getChatMember probe ever runs for a registered user.
--   The other entry point — a registered student posting in such a course's homework topic — is in the bot (same
--   engine, source 'bot_topic').

insert into public.platform_settings (key, value)
values ('multi_course', jsonb_build_object('auto_add_course_ids', jsonb_build_array('36e79750-6dd6-4f1d-ac6f-c74c7237ec86')))
on conflict (key) do nothing;

create or replace function public.auto_add_course_on_join(_telegram_id bigint, _chat_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _ids text[];
  _uid uuid;
  _course uuid;
  _group uuid;
  _hold uuid;
  _main_course uuid;
  _sec uuid;
begin
  select coalesce(array_agg(lower(x)), '{}') into _ids
    from jsonb_array_elements_text(coalesce((select value->'auto_add_course_ids' from public.platform_settings
                                              where key = 'multi_course' and jsonb_typeof(value->'auto_add_course_ids') = 'array'),
                                             '[]'::jsonb)) x;
  if cardinality(_ids) = 0 then
    return jsonb_build_object('status', 'off');
  end if;

  select p.id into _uid from public.profiles p
   where p.telegram_id = _telegram_id and p.status = 'active' and p.archived_at is null;
  if _uid is null then
    return jsonb_build_object('status', 'no_profile');   -- not registered: /start's membership gate handles them
  end if;
  if exists (select 1 from public.user_roles r where r.user_id = _uid and r.role in ('teacher', 'admin', 'superadmin')) then
    return jsonb_build_object('status', 'staff', 'user_id', _uid);
  end if;

  -- the chat: a real group of a listed, published course …
  select g.id, g.course_id into _group, _course
    from public.groups g join public.courses c on c.id = g.course_id and c.published
   where lower(c.id::text) = any(_ids)
     and g.id is distinct from c.channel_group_id
     and (g.daily_task_chat_id = _chat_id
          or exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                      where u ~ '/c/\d+/' and ('-100' || (regexp_match(u, '/c/(\d+)/'))[1])::bigint = _chat_id))
   order by (g.homework_topic_id is not null) desc, g.created_at desc
   limit 1;
  -- … else its channel → the holding group
  if _group is null then
    select c.id, c.channel_group_id into _course, _group
      from public.courses c
     where c.published and lower(c.id::text) = any(_ids)
       and c.telegram_channel_chat_id = _chat_id and c.channel_group_id is not null
     limit 1;
  end if;
  if _group is null then
    return jsonb_build_object('status', 'not_auto_add_chat', 'user_id', _uid);
  end if;

  select g.course_id into _main_course from public.profiles p join public.groups g on g.id = p.group_id where p.id = _uid;
  if _main_course = _course then
    return jsonb_build_object('status', 'main_course', 'user_id', _uid, 'course_id', _course);
  end if;

  select channel_group_id into _hold from public.courses where id = _course;
  select s.group_id into _sec from public.student_course_groups s
   where s.user_id = _uid and s.course_id = _course and not s.is_main;
  if _sec is not null and (_sec is distinct from _hold or _group = _hold) then
    -- already in a real group of it, or joined the channel while already in it: nothing to do
    return jsonb_build_object('status', 'already', 'user_id', _uid, 'course_id', _course, 'group_id', _sec);
  end if;

  return public.add_student_course_group(_uid, _group, 'telegram_join', null);
end
$function$;
revoke execute on function public.auto_add_course_on_join(bigint, bigint) from public, anon, authenticated;
grant execute on function public.auto_add_course_on_join(bigint, bigint) to service_role;

-- self-test (read-only paths only): an unknown Telegram user and an unknown chat change nothing
do $test$
declare _r jsonb;
begin
  _r := public.auto_add_course_on_join(-1, -1);
  if _r->>'status' not in ('no_profile', 'off') then
    raise exception 'self-test: an unknown telegram id must be no_profile, got %', _r;
  end if;
end $test$;
