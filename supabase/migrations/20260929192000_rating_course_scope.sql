-- Rating course scope: group ratings stop mixing courses.
--
-- The group rating primitive is user_group_rating_xp(uid, course) and its windowed twin
-- user_group_rating_xp_since(uid, course, since): the student's XP minus the lesson/homework XP of
-- OTHER courses. Every caller, verified 2026-09-29 against live pg_proc, cron.job and the repo:
--   user_group_rating_xp:       group_leaderboard (website /leaderboard all-time tab, bot /leaderboard),
--                               profile_stats.group_rank (Dashboard, Profile, bot profile),
--                               group_student_leaderboard 'alltime' (TeacherStats, teacher-daily-digest,
--                               tg-group-board = the Mini App board).
--   user_group_rating_xp_since: group_student_leaderboard 'weekly'; post_group_weekly_boards (cron
--                               'group-weekly-board', Mon 04:00 UTC) and freeze_challenge_week (cron
--                               'challenge-weekly' via challenge_weekly_job, Mon 04:10 UTC — challenge
--                               prizes), both as since(prev_mon) - since(this_mon); and the website
--                               /leaderboard weekly tab (src/pages/Leaderboard.tsx), the only caller
--                               that passes a NULL course.
-- No edge function and no cron job calls either function directly.
--
-- TWO GAPS, ONE CLASS ("the rating counts XP that is not this course's"):
--
-- (a) The website weekly tab passes _course_id NULL, and `m.course_id <> NULL` is NULL, so nothing
--     was ever subtracted: that tab ranked by the student's whole weekly XP while the Monday board
--     ranked by the course-scoped number. The page cannot pass the course itself: `groups` has one
--     RLS policy, 'groups admin all', so a student cannot read groups.course_id, and no
--     student-callable RPC returns it. FIX: a NULL _course_id now means the member's OWN group
--     course. Everyone on a group board is in the viewer's group, so that is the viewer's course.
--     Every SQL caller passes a group's course_id, which is NULL only for a group with no course;
--     the member's own group course is then NULL too, so those callers get exactly what they got.
--
-- (b) Course-agnostic XP follows a student into every LATER course. Only lesson_complete /
--     homework_submit / homework_high_score are attributed to a course; daily_active, streak_7,
--     streak_30, community_help, community_question (and the challenge_* reasons from 2026-10-01)
--     are not, and neither is content XP whose lesson/assignment no longer exists (854 events,
--     16,710 pts, 304 users, 2026-05-01..08-13). All of it counts toward whichever course the
--     student is in NOW. Measured: the 164 non-staff 5.0 members, moved into a 6.0 group today,
--     would start the 6.0 board with avg 247 / p50 160 / p90 680 / max 1080 such points.
--     FIX (user_course_join_floor): if a student demonstrably belonged to ANOTHER course before
--     joining course C — an enrollment in another course dated earlier than their C enrollment, or
--     lesson/homework XP of another existing course earned before it — then XP earned before their
--     C enrollment counts toward C only if it is C's own lesson/homework XP. Otherwise nothing
--     changes: a single-course student's rating stays equal to their account XP, which is the
--     invariant the "555 in account, 390 on the board" incident established.
--
-- WHY THE FLOOR IS ONLY FOR MOVERS. The obvious rule, "course-agnostic XP counts only from
-- enrolled_at in C" for everyone, was measured against live data first and is WRONG here: 9 of the
-- 165 current 5.0 members have XP dated before their 5.0 enrolled_at (510 pts would be removed, 10
-- ranks would change, max shift 2). Four of those enrollments are one batch, 2026-07-01 12:00-12:42,
-- for students active since 06-10..06-15 — the timestamp postdates the real start. The other five
-- are 4.0-era students (profiles 2026-04-26..05-05) whose only enrollment is 5.0; one of those is
-- dated 2026-07-05 19:35, the rebuild day.
-- enrolled_at IS a reliable floor for a FUTURE move: trg_profiles_sync_group_enrollment inserts the
-- (student, group course) enrollment the moment profiles.group_id is set (enrolled_at defaults to
-- now()), and admin-create-students' existing-student path moves the group without deleting the old
-- enrollment.
--
-- EFFECT TODAY: NONE. 0 of the 668 enrollments has an earlier enrollment in another course or
-- earlier other-course lesson/homework XP, so the floor is NULL for every (student, course) pair.
-- Read-only simulation on 2026-09-29 for all 165 members of the three 5.0 groups (the only
-- published course with members; 6.0 has 4 groups and 0 members): all-time rating, this week,
-- last week's Monday-board delta and the website weekly tab — 0 scores and 0 ranks differ.
-- The self-test below re-proves this on the data of the moment the migration runs.
--
-- WEEKLY DELTAS STAY EXACT. post_group_weekly_boards and freeze_challenge_week score a week as
-- since(prev_mon) - since(this_mon). The new term's condition does not depend on _since, so the
-- difference is still exactly "points earned in [prev_mon, this_mon)" under one attribution rule.
--
-- NOT CHANGED, on purpose: challenge_team_board sums every xp_event in the window for its members
-- (the owner's "every activity earns"), so a mover's old-course lesson in a challenge week still
-- counts for their TEAM; leaderboard_cache is the 30-day activity score, not XP; the Dashboard's
-- weekly XP is account XP by design.
-- KNOWN LIMITS: a mover whose old enrollment was deleted AND who has no lesson/homework XP in another
-- existing course is not recognised (of the 164 non-staff 5.0 members: 10 have no 5.0 content XP,
-- carrying 2 pts between them). Deleting and re-adding the C enrollment moves the floor forward.
--
-- Rewrites follow the pinned pattern: start from the LIVE pg_get_functiondef, require the body md5
-- verified today, apply asserted replace()s (each old text must occur exactly once), EXECUTE, then
-- assert the stored definition equals what was executed and owner/ACL/SECURITY DEFINER are unchanged.
-- A replay (already rewritten) is detected by the helper's name in the body and skipped.
-- Signatures, return types and grants are unchanged. The self-test CALLS only the two rating
-- functions and the helper: STABLE, read-only, no JWT guard, no advisory lock, no Telegram.

-- ─────────────── 1. helper: when did a MOVER join this course ───────────────
-- NULL = no floor: the student never belonged to another course before this one, or has no
-- enrollment in it. Runs with its caller's rights (the rating functions are postgres-owned
-- SECURITY DEFINER), so nobody else needs EXECUTE.
create or replace function public.user_course_join_floor(_uid uuid, _course_id uuid)
returns timestamptz
language sql
stable
set search_path to 'public'
as $function$
  select ec.enrolled_at
  from enrollments ec
  where ec.user_id = _uid
    and ec.course_id = _course_id
    and (
      exists (select 1 from enrollments eo
              where eo.user_id = _uid
                and eo.course_id <> _course_id
                and eo.enrolled_at < ec.enrolled_at)
      or exists (select 1 from xp_events e
                 where e.user_id = _uid
                   and e.created_at < ec.enrolled_at
                   and (case
                          when e.reason = 'lesson_complete' then exists (
                            select 1 from lessons l join modules m on m.id = l.module_id
                            where l.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id)
                          when e.reason in ('homework_submit', 'homework_high_score') then exists (
                            select 1 from homework_assignments a join modules m on m.id = a.module_id
                            where a.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id)
                          else false
                        end))
    );
$function$;

revoke execute on function public.user_course_join_floor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_course_join_floor(uuid, uuid) to service_role;

-- ─────────────── 2. pinned rewrites of the two rating functions ───────────────
do $$
declare
  _old_head constant text := E'AS $function$\n  select coalesce(';
  _new_head constant text := E'AS $function$\n'
    || E'  with rc as (\n'
    || E'    -- rating-course-scope (20260929192000): a NULL _course_id means the member''s own group\n'
    || E'    -- course; floor_at is NULL unless the student joined this course from another one.\n'
    || E'    select r.cid, public.user_course_join_floor(_uid, r.cid) as floor_at\n'
    || E'    from (select coalesce(_course_id,\n'
    || E'                          (select g.course_id from profiles p join groups g on g.id = p.group_id\n'
    || E'                            where p.id = _uid)) as cid) r\n'
    || E'  )\n'
    || E'  select coalesce(';
  _old_les  constant text := E'where l.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id <> _course_id))';
  _new_les  constant text := E'where l.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id <> (select cid from rc)))';
  _old_hw   constant text := E'where a.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id <> _course_id))';
  _new_hw   constant text := E'where a.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id <> (select cid from rc)))';
  _old_tail constant text := E'\n         ), 0);\n$function$';
  -- %s = the since-window condition (empty for the all-time function).
  _new_tail constant text := E'\n         ), 0)\n'
    || E'       - coalesce((\n'
    || E'           -- XP from before the student joined this course from another one counts only if it is\n'
    || E'           -- this course''s own lesson/homework XP (other courses'' content is subtracted above).\n'
    || E'           select sum(e.amount)::int\n'
    || E'           from xp_events e\n'
    || E'           where e.user_id = _uid%s\n'
    || E'             and e.created_at < (select floor_at from rc)\n'
    || E'             and not (case\n'
    || E'                   when e.reason = ''lesson_complete'' then exists (\n'
    || E'                     select 1 from lessons l join modules m on m.id = l.module_id\n'
    || E'                     where l.id = split_part(e.ref_key, '':'', 2)::uuid)\n'
    || E'                   when e.reason in (''homework_submit'', ''homework_high_score'') then exists (\n'
    || E'                     select 1 from homework_assignments a join modules m on m.id = a.module_id\n'
    || E'                     where a.id = split_part(e.ref_key, '':'', 2)::uuid)\n'
    || E'                   else false\n'
    || E'                 end)\n'
    || E'         ), 0);\n'
    || E'$function$';
  r record;
  _fn oid;
  _def text; _new text; _src text; _old text; _rep text;
  _acl text; _owner oid; _secdef boolean;
  _n int; _i int;
begin
  for r in
    select * from (values
      -- signature,                                                           live body md5 (2026-09-29),         since-window condition
      ('public.user_group_rating_xp(uuid,uuid)',                              '96fc43900ab0782f669efd6524d65270', ''),
      ('public.user_group_rating_xp_since(uuid,uuid,timestamp with time zone)', '4433f919b93fb747e05bbe4dac508e32', ' and e.created_at >= _since')
    ) v(sig, pin, win)
  loop
    _fn := to_regprocedure(r.sig);
    if _fn is null then
      raise exception 'ABORT: % not found', r.sig;
    end if;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    -- Replay: already rewritten -> skip (the helper's name only appears after this migration).
    if position('user_course_join_floor(' in _src) > 0 then
      raise notice '% already rewritten - skipped', r.sig;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified (md5 %); regenerate this migration from the live definition',
        r.sig, md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    for _i in 1..4 loop
      _old := case _i when 1 then _old_head when 2 then _old_les when 3 then _old_hw else _old_tail end;
      _rep := case _i when 1 then _new_head when 2 then _new_les when 3 then _new_hw
                      else format(_new_tail, r.win) end;
      _n := (length(_new) - length(replace(_new, _old, ''))) / length(_old);
      if _n <> 1 then
        raise exception 'ABORT: % - edit % anchor found % times (want 1)', r.sig, _i, _n;
      end if;
      _new := replace(_new, _old, _rep);
    end loop;
    if position('_course_id <>' in _new) > 0 then
      raise exception 'ABORT: % - an unresolved _course_id comparison survived the rewrite', r.sig;
    end if;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % - stored definition differs from what was executed', r.sig;
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % - owner, ACL or SECURITY DEFINER changed', r.sig;
    end if;
  end loop;

  -- The helper: callable by the postgres-owned rating functions, by nobody on the API.
  if not has_function_privilege('postgres', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE') then
    raise exception 'ABORT: postgres cannot EXECUTE user_course_join_floor';
  end if;
  if has_function_privilege('anon', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE') then
    raise exception 'ABORT: user_course_join_floor is reachable from the API';
  end if;
end $$;

-- ─────────────── 3. self-test on live data (read-only) ───────────────
-- ONE statement, so the rewritten functions and the verbatim pre-rewrite formula see the same
-- snapshot (a STABLE function uses its calling query's snapshot): XP that lands mid-migration cannot
-- make them disagree. For every member of every published course's groups:
--   * no floor (every member today) -> all-time rating and last week's Monday-board delta are
--     IDENTICAL to the old formula;
--   * a NULL course gives exactly the member's-group-course number (the website weekly tab).
-- Members WITH a floor (someone moved between review and deploy) are counted, not compared.
do $$
declare
  _members int; _movers int; _changed int; _null_mismatch int;
begin
  with m as (
    select p.id as uid, g.course_id as cid,
           (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent') as this_mon
    from public.profiles p
    join public.groups g on g.id = p.group_id
    join public.courses c on c.id = g.course_id
    where c.published and p.status = 'active' and p.archived_at is null
  ), v as (
    select m.uid,
      public.user_course_join_floor(m.uid, m.cid) as floor_at,
      public.user_group_rating_xp(m.uid, m.cid) as new_all,
      public.user_group_rating_xp(m.uid, null) as new_all_null,
      public.user_group_rating_xp_since(m.uid, m.cid, m.this_mon - interval '7 days')
        - public.user_group_rating_xp_since(m.uid, m.cid, m.this_mon) as new_lastwk,
      public.user_group_rating_xp_since(m.uid, m.cid, m.this_mon) as new_wk,
      public.user_group_rating_xp_since(m.uid, null, m.this_mon) as new_wk_null,
      -- pre-rewrite user_group_rating_xp(uid, cid), verbatim
      coalesce((select x.total_xp from public.user_xp x where x.user_id = m.uid), 0)
        - coalesce((
            select sum(e.amount)::int from public.xp_events e
            where e.user_id = m.uid
              and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
              and ((e.reason = 'lesson_complete' and exists (
                      select 1 from public.lessons l join public.modules mo on mo.id = l.module_id
                      where l.id = split_part(e.ref_key, ':', 2)::uuid and mo.course_id <> m.cid))
                or (e.reason in ('homework_submit', 'homework_high_score') and exists (
                      select 1 from public.homework_assignments a join public.modules mo on mo.id = a.module_id
                      where a.id = split_part(e.ref_key, ':', 2)::uuid and mo.course_id <> m.cid)))
          ), 0) as old_all,
      -- pre-rewrite since(prev_mon) - since(this_mon) = the same formula over [prev_mon, this_mon)
      coalesce((
          select sum(e.amount)::int from public.xp_events e
          where e.user_id = m.uid
            and e.created_at >= m.this_mon - interval '7 days' and e.created_at < m.this_mon
        ), 0)
        - coalesce((
            select sum(e.amount)::int from public.xp_events e
            where e.user_id = m.uid
              and e.created_at >= m.this_mon - interval '7 days' and e.created_at < m.this_mon
              and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
              and ((e.reason = 'lesson_complete' and exists (
                      select 1 from public.lessons l join public.modules mo on mo.id = l.module_id
                      where l.id = split_part(e.ref_key, ':', 2)::uuid and mo.course_id <> m.cid))
                or (e.reason in ('homework_submit', 'homework_high_score') and exists (
                      select 1 from public.homework_assignments a join public.modules mo on mo.id = a.module_id
                      where a.id = split_part(e.ref_key, ':', 2)::uuid and mo.course_id <> m.cid)))
          ), 0) as old_lastwk
    from m
  )
  select count(*),
         count(*) filter (where floor_at is not null),
         count(*) filter (where floor_at is null and (new_all <> old_all or new_lastwk <> old_lastwk)),
         count(*) filter (where new_all_null <> new_all or new_wk_null <> new_wk)
    into _members, _movers, _changed, _null_mismatch
  from v;

  if _changed > 0 then
    raise exception 'ABORT: % single-course member(s) got a different rating or weekly delta', _changed;
  end if;
  if _null_mismatch > 0 then
    raise exception 'ABORT: % member(s) - a NULL course did not resolve to their group course', _null_mismatch;
  end if;
  raise notice 'rating-course-scope self-test: % members identical, % mover(s) not compared', _members - _movers, _movers;

  if not exists (select 1 from public.admin_actions where action = 'rating_course_scope_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'rating_course_scope_applied', jsonb_build_object(
      'rewritten', jsonb_build_array('user_group_rating_xp', 'user_group_rating_xp_since'),
      'helper', 'user_course_join_floor',
      'members_checked', _members, 'movers', _movers, 'at', now()));
  end if;
end $$;
