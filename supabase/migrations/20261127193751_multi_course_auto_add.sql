-- Multi-course students, PR 3a: automatic adding (owner, 2026-11-27). Only for the courses on an explicit list —
-- the owner did not choose between "any course" and "new courses only", so the cautious one: a course is
-- auto-added only when it is listed in platform_settings 'multi_course'.auto_add_course_ids. Starts with
-- CLAUDE STUDIO alone; older cohorts (5.0 / 6.0 / 7.0) are never added automatically (3 students of 6.0 sit in
-- 5.0 / 7.0 chats today — they stay as they are, an admin adds them by hand if wanted).
--
--   1. platform_settings 'multi_course' = {"auto_add_course_ids": ["<CLAUDE STUDIO>"]}   (kill-switch: empty list)
--   2. auto_add_target_for_chat(chat_id): pure read — which group of a LISTED, published course a Telegram chat is:
--        a real group's chat (the /c/<id>/ of its topic / group / daily-task link or a module topic, or
--        daily_task_chat_id) → that group ('group'); more than one real group behind the chat → 'ambiguous' (nobody
--        is added: the group decides the tier); the course's channel → its holding group ('channel').
--   3. auto_add_course_on_join(telegram_id, chat_id): called by the bot on a chat_member JOIN. The chat is resolved
--      FIRST (most joins are in other courses' chats: one cheap read and out). Then a registered, active student who
--      is not staff (user_roles teacher/admin/superadmin, or a primary / co-teacher of any group) and for whom the
--      course is not their main course gets it as a second course through add_student_course_group (audited, source
--      'telegram_join'). A student whose only place in the course is its holding group and who joins a real group's
--      chat is moved into that group ('changed'); one already in a real group is left there.
--      Event-driven: no getChatMember probe ever runs for a registered user (CLAUDE.md).
--   The other entry point — a registered student posting in such a course's homework topic — is in the bot (same
--   engine, source 'bot_topic').
-- (Supersedes the never-merged draft 20261127193400: unbounded \d+ cast, non-deterministic shared-chat pick, no
-- group_teachers exclusion, a self-test that did not exercise the mapping — all from review.)

insert into public.platform_settings (key, value)
values ('multi_course', jsonb_build_object('auto_add_course_ids', jsonb_build_array('36e79750-6dd6-4f1d-ac6f-c74c7237ec86')))
on conflict (key) do nothing;

create or replace function public.auto_add_target_for_chat(_chat_id bigint)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _ids text[];
  _n int;
  _group uuid;
  _course uuid;
begin
  select coalesce(array_agg(lower(x)), '{}') into _ids
    from jsonb_array_elements_text(coalesce((select value->'auto_add_course_ids' from public.platform_settings
                                              where key = 'multi_course' and jsonb_typeof(value->'auto_add_course_ids') = 'array'),
                                             '[]'::jsonb)) x;
  if cardinality(_ids) = 0 then
    return jsonb_build_object('status', 'off');
  end if;

  -- real groups of listed, published courses whose chat this is (ids bounded to 13 digits: a pasted message link or a
  -- typo can never make the cast fail for every join)
  with cand as (
    select distinct g.id, g.course_id
      from public.groups g
      join public.courses c on c.id = g.course_id and c.published
     where lower(c.id::text) = any(_ids)
       and g.id is distinct from c.channel_group_id
       and (g.daily_task_chat_id = _chat_id
            or exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                        where u ~ '/c/\d{1,13}/'
                          and ('-100' || (regexp_match(u, '/c/(\d{1,13})/'))[1])::bigint = _chat_id)
            or exists (select 1 from public.group_module_topics t
                        where t.group_id = g.id and t.telegram_topic_url ~ '/c/\d{1,13}/'
                          and ('-100' || (regexp_match(t.telegram_topic_url, '/c/(\d{1,13})/'))[1])::bigint = _chat_id))
  )
  select count(*), min(id::text)::uuid, min(course_id::text)::uuid into _n, _group, _course from cand;
  if _n > 1 then
    return jsonb_build_object('status', 'ambiguous', 'groups', _n);
  end if;
  if _n = 1 then
    return jsonb_build_object('status', 'group', 'course_id', _course, 'group_id', _group);
  end if;

  -- the course's channel → its holding group
  select c.id, c.channel_group_id into _course, _group
    from public.courses c
   where c.published and lower(c.id::text) = any(_ids)
     and c.telegram_channel_chat_id = _chat_id and c.channel_group_id is not null
   order by c.id
   limit 1;
  if _group is not null then
    return jsonb_build_object('status', 'channel', 'course_id', _course, 'group_id', _group);
  end if;
  return jsonb_build_object('status', 'not_auto_add_chat');
end
$function$;
revoke execute on function public.auto_add_target_for_chat(bigint) from public, anon, authenticated;
grant execute on function public.auto_add_target_for_chat(bigint) to service_role;

create or replace function public.auto_add_course_on_join(_telegram_id bigint, _chat_id bigint)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _t jsonb;
  _uid uuid;
  _course uuid;
  _group uuid;
  _hold uuid;
  _main_course uuid;
  _sec uuid;
begin
  _t := public.auto_add_target_for_chat(_chat_id);
  if _t->>'status' not in ('group', 'channel') then
    return _t;   -- off / not_auto_add_chat / ambiguous: nothing to do
  end if;
  _course := (_t->>'course_id')::uuid;
  _group := (_t->>'group_id')::uuid;

  select p.id into _uid from public.profiles p
   where p.telegram_id = _telegram_id and p.status = 'active' and p.archived_at is null;
  if _uid is null then
    return jsonb_build_object('status', 'no_profile');   -- not registered: /start's membership gate handles them
  end if;
  if exists (select 1 from public.user_roles r where r.user_id = _uid and r.role in ('teacher', 'admin', 'superadmin'))
     or exists (select 1 from public.groups g where g.teacher_id = _uid)
     or exists (select 1 from public.group_teachers gt where gt.teacher_id = _uid) then
    return jsonb_build_object('status', 'staff', 'user_id', _uid);
  end if;

  select g.course_id into _main_course from public.profiles p join public.groups g on g.id = p.group_id where p.id = _uid;
  if _main_course = _course then
    return jsonb_build_object('status', 'main_course', 'user_id', _uid, 'course_id', _course);
  end if;

  select channel_group_id into _hold from public.courses where id = _course;
  select s.group_id into _sec from public.student_course_groups s
   where s.user_id = _uid and s.course_id = _course and not s.is_main;
  if _sec is not null and (_sec is distinct from _hold or _group = _hold) then
    -- already in a real group of it (never moved by a join), or joined the channel while already in it
    return jsonb_build_object('status', 'already', 'user_id', _uid, 'course_id', _course, 'group_id', _sec);
  end if;

  return public.add_student_course_group(_uid, _group, 'telegram_join', null);
end
$function$;
revoke execute on function public.auto_add_course_on_join(bigint, bigint) from public, anon, authenticated;
grant execute on function public.auto_add_course_on_join(bigint, bigint) to service_role;

-- ── self-test (read-only: only the pure resolver and the no_profile path run) ──
do $test$
declare _r jsonb; _real uuid; _hold uuid;
begin
  _r := public.auto_add_course_on_join(-1, -1);
  if _r->>'status' not in ('not_auto_add_chat', 'off') then
    raise exception 'self-test: an unknown chat must resolve to nothing, got %', _r;
  end if;

  select id into _real from public.groups
   where course_id = '36e79750-6dd6-4f1d-ac6f-c74c7237ec86' and name = 'CLAUDE STUDIO | 1 - GURUH';
  select channel_group_id into _hold from public.courses where id = '36e79750-6dd6-4f1d-ac6f-c74c7237ec86';
  if _real is null or _hold is null then
    raise notice 'CLAUDE STUDIO groups not found — mapping self-test skipped';
    return;
  end if;
  _r := public.auto_add_target_for_chat(-1004481103852);
  if _r->>'status' <> 'group' or (_r->>'group_id')::uuid <> _real then
    raise exception 'self-test: the CLAUDE STUDIO group chat must map to its group, got %', _r;
  end if;
  _r := public.auto_add_target_for_chat(-1004450754958);
  if _r->>'status' <> 'channel' or (_r->>'group_id')::uuid <> _hold then
    raise exception 'self-test: the CLAUDE STUDIO channel must map to its holding group, got %', _r;
  end if;
  _r := public.auto_add_target_for_chat(-1004483114241);   -- a 7.0 group chat: not on the list
  if _r->>'status' <> 'not_auto_add_chat' then
    raise exception 'self-test: a chat of a course not on the list must be ignored, got %', _r;
  end if;
end $test$;
