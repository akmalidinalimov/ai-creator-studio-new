-- Multi-course students, PR 4 of 4: member lists + the channel holding row of a SECONDARY course (owner, 2026-11-27).
--
-- PR 1 (20261127143100) lets a student be in a SECOND course (student_course_groups, non-main row) while their main
-- group stays profiles.group_id. Two database paths still saw only profiles.group_id:
--
--   staff_group_members(group)   the group's member list (Admin → Guruhlar → a group; teachers' group view). A student
--                                whose SECONDARY group this is was missing from it. Now listed too. The output shape is
--                                unchanged (RETURNS TABLE is not touched); the website marks such a member and does not
--                                offer "remove from group" for them (that clears profiles.group_id = the MAIN group).
--   course_membership_place(uid, course, chat)
--                                a student registered through a course's channel (its holding group, «… | KANAL») who
--                                is seen in a REAL group chat of the course is moved into that group. It looked only at
--                                profiles.group_id, so a student whose SECOND course is held in the holding group stayed
--                                there forever (on 2026-11-27 both secondary students — CLAUDE STUDIO — are in it).
--                                Now the secondary holding row is moved too, through the one engine
--                                add_student_course_group(uid, realGroup, 'membership_place', null) → 'changed'
--                                (audited student_course_changed + course_membership_placed, as the main path is).
--   course_membership_due(limit) its in_holding flag is what makes the checker (edge fn course-membership-check) call
--                                course_membership_place at all; it gets the same secondary-row case. (The other caller,
--                                course_membership_seen — a join / /start in a course chat — iterates enrollments, and
--                                a secondary course always has its enrollment, so it reaches the new branch unchanged.)
--
-- Single-course students (no non-main row): every output is exactly what it was (asserted below).
-- Live bodies only: staff_group_members and course_membership_due are regexp-patched from pg_get_functiondef, pinned to
-- the md5 of the prosrc reviewed on 2026-11-27 (the pg_temp.mc2_patch pattern of 20261127180654); course_membership_place
-- is small, its live text equals 20261030145000's, so it is rewritten whole behind the same md5 pin.
-- Replay-safe: a body already carrying the marker /* multi-course PR4 */ is skipped.

-- ── the patcher (session-local) ──
create or replace function pg_temp.mc4_patch(_fn regprocedure, _md5 text, _pats text[], _reps text[], _counts int[])
returns text language plpgsql as $function$
declare
  _src text;
  _def text;
  _i int;
  _n int;
begin
  select prosrc into _src from pg_proc where oid = _fn;
  if position('/* multi-course PR4 */' in _src) > 0 then
    return _fn::text || ': already';
  end if;
  if md5(_src) <> _md5 then
    raise exception '% changed since it was reviewed (2026-11-27) — refusing to patch', _fn;
  end if;
  _def := pg_get_functiondef(_fn);
  for _i in 1 .. array_length(_pats, 1) loop
    select count(*) into _n from regexp_matches(_def, _pats[_i], 'g');
    if _n <> _counts[_i] then
      raise exception '%: pattern % matched % time(s), expected %', _fn, _i, _n, _counts[_i];
    end if;
    _def := regexp_replace(_def, _pats[_i], _reps[_i], 'g');
  end loop;
  if position('/* multi-course PR4 */' in _def) = 0 then
    raise exception '%: patched text carries no marker', _fn;
  end if;
  execute _def;  -- CREATE OR REPLACE: owner, grants and SECURITY DEFINER are kept
  return _fn::text || ': patched';
end
$function$;

-- ── course_membership_place: + the secondary holding row (whole rewrite behind the md5 pin) ──
do $pin$
declare _src text := (select prosrc from pg_proc where oid = 'public.course_membership_place(uuid,uuid,bigint)'::regprocedure);
begin
  if position('/* multi-course PR4 */' in _src) > 0 then
    return;  -- already this version (a replay)
  end if;
  if md5(_src) <> '81ff18c3ad623fe27680d90fe0e1bb86' then
    raise exception 'course_membership_place changed since it was reviewed (2026-11-27) — refusing to overwrite';
  end if;
end $pin$;

create or replace function public.course_membership_place(_uid uuid, _course uuid, _chat_id bigint)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _hold uuid; _target uuid; _main boolean; _sec boolean; _r jsonb;
begin
  /* multi-course PR4 */
  select channel_group_id into _hold from public.courses where id = _course;
  if _hold is null then return null; end if;
  -- the main group is the holding group (as before), or a SECONDARY course of the student is held there (PR 4)
  _main := exists (select 1 from public.profiles where id = _uid and group_id = _hold);
  _sec := not _main and exists (select 1 from public.student_course_groups
                                 where user_id = _uid and course_id = _course and group_id = _hold and not is_main);
  if not _main and not _sec then return null; end if;
  -- (chat ids bounded to 13 digits: a pasted message link or a typo in a group's url can never make the cast fail)
  select g.id into _target
    from public.groups g
   where g.course_id = _course and g.id <> _hold
     and (g.daily_task_chat_id = _chat_id
          or exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                      where u ~ '/c/\d{1,13}/' and ('-100' || (regexp_match(u, '/c/(\d{1,13})/'))[1])::bigint = _chat_id)
          or exists (select 1 from public.group_module_topics t
                      where t.group_id = g.id and t.telegram_topic_url ~ '/c/\d{1,13}/'
                        and ('-100' || (regexp_match(t.telegram_topic_url, '/c/(\d{1,13})/'))[1])::bigint = _chat_id))
   order by g.created_at limit 1;
  if _target is null then return null; end if;
  if _main then
    update public.profiles set group_id = _target where id = _uid and group_id = _hold;
    if found then
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      values (null, 'course_membership_placed', _uid, jsonb_build_object('course_id', _course, 'from_group', _hold,
              'to_group', _target, 'chat_id', _chat_id));
      return _target;
    end if;
    return null;
  end if;
  -- the secondary course: the one engine (upserts the row + the enrollment's tier, audits student_course_changed)
  _r := public.add_student_course_group(_uid, _target, 'membership_place', null);
  if _r->>'status' = 'changed' then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'course_membership_placed', _uid, jsonb_build_object('course_id', _course, 'from_group', _hold,
            'to_group', _target, 'chat_id', _chat_id, 'secondary', true));
    return _target;
  end if;
  return null;
end
$function$;
revoke execute on function public.course_membership_place(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.course_membership_place(uuid, uuid, bigint) to service_role;

do $patch$
declare _log jsonb := '[]'::jsonb;
begin
  -- the group's member list: + students whose SECONDARY group this is (output shape unchanged)
  _log := _log || to_jsonb(pg_temp.mc4_patch('public.staff_group_members(uuid)'::regprocedure,
    'd9e5b4eae535efa0b2c6a8fde91a3a43',
    array['WHERE p\.group_id = _group_id'],
    array['WHERE (p.group_id = _group_id /* multi-course PR4 */ OR EXISTS (SELECT 1 FROM public.student_course_groups s WHERE s.user_id = p.id AND s.group_id = _group_id AND NOT s.is_main))'],
    array[1]));

  -- the checker's "in the holding group" flag: + a secondary row of this course held in the holding group
  _log := _log || to_jsonb(pg_temp.mc4_patch('public.course_membership_due(integer)'::regprocedure,
    '198a6f2689d9b25599d3bbeb59d055e9',
    array['p\.group_id is not distinct from c\.channel_group_id'],
    array['(p.group_id is not distinct from c.channel_group_id /* multi-course PR4 */ or exists (select 1 from public.student_course_groups s where s.user_id = e.user_id and s.course_id = e.course_id and not s.is_main and s.group_id = c.channel_group_id))'],
    array[1]));

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'multi_course_member_lists', jsonb_build_object('migration', '20261127214146', 'functions', _log));
end $patch$;

-- ── self-test ──
-- 1. staff_group_members, for EVERY group, lists exactly the main members ∪ the secondary members — so for a group with
--    no secondary row (all but one today) exactly what it listed before. It needs a caller who can see every group
--    (can_see_group → has_role admin): run as a real admin, the JWT claim set inside a sub-block that ends by raising a
--    sentinel, so the setting is rolled back with it. Pure read.
-- 2. course_membership_due: for every row of a student with NO secondary course, in_holding is the old expression.
--    Pure read (LANGUAGE sql, STABLE).
-- 3. course_membership_place, the NEW branch only, inside the same rolled-back sub-block: a secondary holding row (both
--    CLAUDE STUDIO secondary students today) seen in a real group's chat moves to that group and the main group is not
--    touched; an unknown chat moves nothing. The main branch (a profiles.group_id write, with its triggers) is not run.
--    add_student_course_group takes no advisory lock, so the sentinel rollback undoes all of it.
do $test$
declare
  _admin uuid;
  _bad int;
  _r record;
  _chat bigint;
  _real uuid;
  _got uuid;
  _main_before uuid;
  _tested int := 0;
begin
  select count(*) into _bad
    from public.course_membership_due(100000) d
    join public.profiles p on p.id = d.user_id
    join public.courses c on c.id = d.course_id
   where not exists (select 1 from public.student_course_groups s where s.user_id = d.user_id and not s.is_main)
     and d.in_holding is distinct from (p.group_id is not distinct from c.channel_group_id);
  if _bad <> 0 then
    raise exception 'self-test: course_membership_due.in_holding changed for % single-course row(s)', _bad;
  end if;

  select ur.user_id into _admin from public.user_roles ur where ur.role = 'admin'::app_role order by ur.user_id limit 1;
  begin
    if _admin is not null then
      perform set_config('request.jwt.claims', jsonb_build_object('sub', _admin, 'role', 'authenticated')::text, true);
      select count(*) into _bad
        from public.groups g
       where exists (
               (select m.id from public.staff_group_members(g.id) m
                except
                (select p.id from public.profiles p where p.group_id = g.id
                 union select s.user_id from public.student_course_groups s where s.group_id = g.id and not s.is_main))
               union all
               ((select p.id from public.profiles p where p.group_id = g.id
                 union select s.user_id from public.student_course_groups s where s.group_id = g.id and not s.is_main)
                except
                select m.id from public.staff_group_members(g.id) m));
      if _bad <> 0 then
        raise exception 'self-test: staff_group_members disagrees with main ∪ secondary members in % group(s)', _bad;
      end if;
    else
      raise notice 'self-test: no admin user — staff_group_members comparison skipped';
    end if;

    for _r in
      select s.user_id, s.course_id, s.group_id from public.student_course_groups s
        join public.courses c on c.id = s.course_id and c.channel_group_id = s.group_id
       where not s.is_main
    loop
      -- a real group of that course and its chat (same parse as the function)
      select g.id, ('-100' || (regexp_match(g.homework_topic_url, '/c/(\d{1,13})/'))[1])::bigint into _real, _chat
        from public.groups g
       where g.course_id = _r.course_id and g.id <> _r.group_id and g.homework_topic_url ~ '/c/\d{1,13}/'
       order by g.created_at limit 1;
      continue when _real is null;
      if public.course_membership_place(_r.user_id, _r.course_id, -1) is not null then
        raise exception 'self-test: course_membership_place moved % on an unknown chat', _r.user_id;
      end if;
      select group_id into _main_before from public.profiles where id = _r.user_id;
      _got := public.course_membership_place(_r.user_id, _r.course_id, _chat);
      if _got is null
         or not exists (select 1 from public.student_course_groups where user_id = _r.user_id
                          and course_id = _r.course_id and group_id = _got and not is_main)
         or (select group_id from public.profiles where id = _r.user_id) is distinct from _main_before then
        raise exception 'self-test: the secondary holding row of % was not placed (got %)', _r.user_id, _got;
      end if;
      _tested := _tested + 1;
    end loop;
    raise exception 'mc4_selftest_rollback';
  exception when raise_exception then
    if sqlerrm <> 'mc4_selftest_rollback' then raise; end if;
  end;
  raise notice 'self-test: % secondary holding row(s) placed and rolled back', _tested;
end $test$;
