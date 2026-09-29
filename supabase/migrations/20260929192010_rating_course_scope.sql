-- Group rating course scope: a student who comes to a course from another one no longer starts its
-- board with the other course's XP, and the website's weekly tab scores by the group's course like
-- every other board does.
--
-- RE-ISSUE of 20260929192000_rating_course_scope.sql (first attempt, commit 5eeabcf, NEVER APPLIED:
-- no ops_applied_migrations row, and both live bodies still have the md5s pinned below). This file
-- keeps its mover detection (user_course_join_floor) and changes two things:
--   1. challenge_* points are NOT dropped by the floor (see "challenge_* is exempt" below: the first
--      attempt would have removed back-dated challenge points from a mover's prize snapshot);
--   2. NULL keeps its old meaning in both primitives; the website passes the course explicitly via
--      group_rating_course_id() instead of NULL being re-defined as "the member's own group course".
--
-- WHAT WAS WRONG (verified read-only against production, 2026-09-29)
--   user_group_rating_xp(uid, course) = user_xp.total_xp minus lesson/homework XP whose lesson or
--   assignment belongs to ANOTHER course. Every other reason (daily_active, streak_7/_30,
--   community_help/_question, challenge_*) counts toward whatever course the student's group is in
--   NOW, whenever it was earned; user_group_rating_xp_since() is the same with a created_at floor.
--   So a student who already did a course starts a later course's all-time board with the old XP.
--   Measured "if every current student joined a 6.0 group today" (rating toward 6.0):
--     5.0 group members (164):     avg 247, p50 160, p90 680, max 1,080 XP
--     4.0-enrolled students (492): avg 100, p50 60,  p90 260, max 555 XP
--   while a brand-new student starts at 0. Part of it (5.0 avg 10, max 155) is lesson/homework XP
--   whose lesson or assignment no longer exists (486 lesson + 368 homework events platform-wide): it
--   resolves to no course, so the "other course" subtraction never removed it either.
--   The weekly prize snapshot (freeze_challenge_week: since(prev Monday) - since(this Monday)) had
--   the same hole in miniature: in the week a student moves, the days BEFORE the move counted too.
--   Last week 5.0 members earned avg 11, p90 43, max 232 such (non-content) XP.
--
-- WHY NOT "count everything only from enrollments.enrolled_at" (the obvious rule; measured, rejected)
--   enrolled_at is not a reliable start of activity for the 5.0 cohort (production was rebuilt on
--   2026-07-05 by replaying migrations; the enrollment-sync trigger dates from that day): 9 of 165
--   current 5.0 members have XP dated before their 5.0 enrolled_at (430 non-lesson XP, max 100 each),
--   one of them 5.0 lesson completions two hours before it. Anchoring everyone would move 7 current
--   5.0 ranks (max shift 2, none inside a top 10) for no real reason.
--
-- THE RULE
--   user_course_join_floor(uid, course) is NULL unless the student demonstrably came to this course
--   from another one: (1) they hold an enrollment in another course with an EARLIER enrolled_at, or
--   (2) they earned lesson/homework XP of another existing course before enrolling in this one. Then
--   XP created before their enrolled_at here does not count here, except lessons/homework that
--   resolve to a course (this course's own count; another course's are already subtracted by the
--   existing term, so nothing is subtracted twice) and challenge_* points. A NULL floor changes
--   nothing: today that is every one of the 668 enrollments (0 qualify by either signal).
--   * Signal (2) exists because an admin can delete a course enrollment (AdminUsers toggleEnrollment):
--     if every current 5.0 member moved to 6.0 AND lost their 5.0 enrollment, (2) alone would still
--     recognise 154 of the 164.
--   * The floor is trustworthy for a LATER course: trg_profiles_sync_group_enrollment
--     (sync_group_enrollment(), since migration 20260705130000) inserts the (student, group course)
--     enrollment when profiles.group_id is set (a trigger, so whichever code path sets it), and its
--     ON CONFLICT only updates tier_id, never enrolled_at. staff-intake's set_enrollment_tier_system()
--     is the same upsert. Neither removes the older enrollment.
--   * challenge_* is exempt because reconcile_challenge_xp(), the only writer of challenge XP, awards
--     it only while the student's CURRENT group is a challenge-scope group, for a message whose
--     group_message_events.group_id comes from the CHAT (resolveGroupFromChatId), and back-dates
--     created_at to the message's sent_at. A mover who posts in the 6.0 chat shortly before being
--     registered is paid on the first tick after the move with created_at BEFORE their 6.0
--     enrolled_at, and a floor that dropped it would silently take it out of the prize snapshot
--     while it stays in their account XP. The cost: challenge points still follow a student into a
--     LATER course, exactly the accepted limit recorded in 20260920103000's header (it needs a
--     source-group tag on the ledger row).
--   * The weekly delta stays exact: both since() calls apply the same floor, so since(a) - since(b)
--     is the XP in [a, b) minus the same subsets, and it is never negative (xp_events.amount > 0).
--
-- READ-ONLY SIMULATION (2026-09-29), the exact term below against the live bodies:
--   every active profile x {5.0, 6.0, NULL course} -> 0 differences, all-time (2,085) and since this
--   and last Monday (4,170), so last week's freeze delta is unchanged too. With a virtual 6.0
--   enrollment dated last Thursday for all 165 5.0 members: every 5.0 rating and weekly delta
--   unchanged; 6.0 all-time avg 246 -> 10 (what is left is XP earned after the join); the 6.0
--   last-week delta equals "XP after the join minus other-course content" for all 165.
--
-- CALLERS (pg_proc bodies, cron.job, src/, supabase/functions/). Signatures and grants are unchanged.
--   user_group_rating_xp: group_leaderboard (website all-time tab; bot group board), profile_stats
--     (group_rank: Dashboard, Profile, bot profile card), group_student_leaderboard (all-time board:
--     TeacherStats, teacher-daily-digest, tg-group-board).
--   user_group_rating_xp_since: group_student_leaderboard (weekly board), post_group_weekly_boards
--     (cron group-weekly-board, Mon 04:00 UTC), freeze_challenge_week (cron challenge-weekly ->
--     challenge_weekly_job, Mon 04:10 UTC), src/pages/Leaderboard.tsx (weekly tab).
--   Not affected (different sources): challenge_team_board (raw xp_events in the window, so a mover's
--   old-course lessons in a challenge week still count for their TEAM), leaderboard_group_window
--   (leaderboard_cache 30-day activity score), Dashboard weekly XP and tiers (account XP).
--
-- ALSO: group_rating_course_id(uid). The website weekly tab called user_group_rating_xp_since with
--   _course_id = NULL, which subtracts nothing (other courses' lessons counted there and on no other
--   board). The page cannot look the course up itself: `groups` has one RLS policy, admin-only. This
--   returns exactly the course group_leaderboard() scores by, behind the same caller gate. It is not
--   called here: its gate needs a JWT (auth.uid() is NULL in a migration).
--
-- SELF-TEST: before each rewrite, the new text is created as a pg_temp copy and compared with the live
--   function IN ONE STATEMENT (so a concurrent XP award cannot fake a difference) over every active
--   profile x published course (+ NULL): identical wherever the floor is NULL, never higher where it
--   is not, and since(last Monday) >= since(this Monday) everywhere. The rating functions and the
--   floor helper are STABLE reads with no auth check, no lock and no side effect, so calling them
--   here is safe. Then the pinned-rewrite pattern: LIVE pg_get_functiondef, body md5 verified today,
--   each replace()d text must occur exactly once, EXECUTE, stored definition == executed text,
--   owner/ACL/SECURITY DEFINER unchanged. A replay (marker present) is skipped.

-- ─────────────── 1. helper for the website weekly tab ───────────────
create or replace function public.group_rating_course_id(uid uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- The course a student's group rating is scored by: the same lookup as group_leaderboard()'s `my`
  -- CTE, behind the same caller gate. NULL for no group, a group without a course, or another user.
  select g.course_id
  from profiles p
  join groups g on g.id = p.group_id
  where p.id = uid
    and (auth.role() = 'service_role' or uid = auth.uid()
         or public.has_role(auth.uid(), 'admin'::app_role)
         or public.has_role(auth.uid(), 'superadmin'::app_role));
$function$;

revoke execute on function public.group_rating_course_id(uuid) from public, anon, authenticated;
grant execute on function public.group_rating_course_id(uuid) to authenticated, service_role;

-- ─────────────── 2. helper: when did a student who came from another course join this one ───────────────
-- NULL = no floor. Runs with its caller's rights (the rating functions are postgres-owned SECURITY
-- DEFINER), so nobody on the API needs EXECUTE.
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
                   and case
                         when e.reason = 'lesson_complete' then exists (
                           select 1 from lessons l join modules m on m.id = l.module_id
                           where l.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id)
                         when e.reason in ('homework_submit', 'homework_high_score') then exists (
                           select 1 from homework_assignments a join modules m on m.id = a.module_id
                           where a.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id)
                         else false
                       end)
    );
$function$;

revoke execute on function public.user_course_join_floor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_course_join_floor(uuid, uuid) to service_role;

-- ─────────────── 3. pinned rewrites + self-test ───────────────
do $$
declare
  _marker   constant text := 'Prior-course floor (20260929192010)';
  _old_tail constant text := E'         ), 0);\n$function$';
  _why constant text :=
       E'       -- Prior-course floor (20260929192010). user_course_join_floor() is NULL unless the student\n'
    || E'       -- came to this course from another one; then XP created before they enrolled here does not\n'
    || E'       -- count here. Kept: lessons/homework that resolve to a course (this course counts; another\n'
    || E'       -- course is already subtracted above, so nothing is subtracted twice) and challenge_* points\n'
    || E'       -- (awarded only while the student is in a challenge-scope group, back-dated to the message).\n';
  _rest constant text :=
       E'             and e.created_at < (select public.user_course_join_floor(_uid, _course_id))\n'
    || E'             and case\n'
    || E'                   when starts_with(e.reason, ''challenge_'') then false\n'
    || E'                   when e.reason = ''lesson_complete'' then not exists (\n'
    || E'                     select 1 from lessons l join modules m on m.id = l.module_id\n'
    || E'                     where l.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id is not null)\n'
    || E'                   when e.reason in (''homework_submit'', ''homework_high_score'') then not exists (\n'
    || E'                     select 1 from homework_assignments a join modules m on m.id = a.module_id\n'
    || E'                     where a.id = split_part(e.ref_key, '':'', 2)::uuid and m.course_id is not null)\n'
    || E'                   else true\n'
    || E'                 end\n'
    || E'         ), 0);\n$function$';
  _tail_all constant text :=
       E'         ), 0)\n' || _why
    || E'       - coalesce((\n'
    || E'           select sum(e.amount)::int\n'
    || E'           from xp_events e\n'
    || E'           where e.user_id = _uid\n'
    || _rest;
  _tail_since constant text :=
       E'         ), 0)\n' || _why
    || E'       - coalesce((\n'
    || E'           select sum(e.amount)::int\n'
    || E'           from xp_events e\n'
    || E'           where e.user_id = _uid and e.created_at >= _since\n'
    || _rest;
  _this_mon constant timestamptz :=
    (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  r record;
  _fn oid;
  _src text; _def text; _new text; _hdr text; _tmp text;
  _acl text; _owner oid; _secdef boolean;
  _n int; _pairs int; _floored int; _bad int;
  _stats jsonb := '{}'::jsonb;
begin
  -- The floor helper must be callable by the postgres-owned rating functions, by nobody on the API.
  if not has_function_privilege('postgres', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE') then
    raise exception 'ABORT: postgres cannot EXECUTE user_course_join_floor';
  end if;
  if has_function_privilege('anon', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.user_course_join_floor(uuid,uuid)', 'EXECUTE') then
    raise exception 'ABORT: user_course_join_floor is reachable from the API';
  end if;

  for r in
    select * from (values
      -- name,                         live body md5 (2026-09-29),            windowed
      ('user_group_rating_xp',         '96fc43900ab0782f669efd6524d65270',    false),
      ('user_group_rating_xp_since',   '4433f919b93fb747e05bbe4dac508e32',    true)
    ) v(name, pin, windowed)
  loop
    select count(*) into _n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.name;
    if _n <> 1 then
      raise exception 'ABORT: public.% found % times (want exactly 1)', r.name, _n;
    end if;
    select p.oid into _fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.name;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    -- Replay: already rewritten -> skip (the marker only exists after this migration).
    if position(_marker in _src) > 0 then
      raise notice '% already rewritten - skipped', r.name;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified (md5 %); regenerate this migration from the live definition',
        r.name, md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _n := (length(_def) - length(replace(_def, _old_tail, ''))) / length(_old_tail);
    if _n <> 1 then
      raise exception 'ABORT: % - closing text found % times (want 1)', r.name, _n;
    end if;
    _new := replace(_def, _old_tail, case when r.windowed then _tail_since else _tail_all end);

    -- DRY RUN: the exact new text as a pg_temp function, compared with the live one in ONE statement.
    _hdr := 'CREATE OR REPLACE FUNCTION public.' || r.name || '(';
    _n := (length(_new) - length(replace(_new, _hdr, ''))) / length(_hdr);
    if _n <> 1 then
      raise exception 'ABORT: % - header found % times (want 1)', r.name, _n;
    end if;
    _tmp := replace(_new, _hdr, 'CREATE FUNCTION pg_temp.' || r.name || '_next(');
    execute _tmp;

    if r.windowed then
      select count(*)::int,
             count(*) filter (where v.floored)::int,
             count(*) filter (where
                  (not v.floored and (v.nxt_this is distinct from v.cur_this
                                      or v.nxt_prev is distinct from v.cur_prev))
               or (v.floored and not coalesce(v.nxt_this <= v.cur_this and v.nxt_prev <= v.cur_prev, false))
               or not coalesce(v.nxt_prev >= v.nxt_this, false))::int
        into _pairs, _floored, _bad
        from (
          select public.user_course_join_floor(p.id, c.id) is not null as floored,
                 public.user_group_rating_xp_since(p.id, c.id, _this_mon) as cur_this,
                 pg_temp.user_group_rating_xp_since_next(p.id, c.id, _this_mon) as nxt_this,
                 public.user_group_rating_xp_since(p.id, c.id, _this_mon - interval '7 days') as cur_prev,
                 pg_temp.user_group_rating_xp_since_next(p.id, c.id, _this_mon - interval '7 days') as nxt_prev
            from profiles p
           cross join (select id from courses where published union all select null::uuid) c(id)
           where p.status = 'active' and p.archived_at is null
        ) v;
      drop function pg_temp.user_group_rating_xp_since_next(uuid, uuid, timestamptz);
    else
      select count(*)::int,
             count(*) filter (where v.floored)::int,
             count(*) filter (where
                  (not v.floored and v.nxt is distinct from v.cur)
               or (v.floored and not coalesce(v.nxt <= v.cur, false)))::int
        into _pairs, _floored, _bad
        from (
          select public.user_course_join_floor(p.id, c.id) is not null as floored,
                 public.user_group_rating_xp(p.id, c.id) as cur,
                 pg_temp.user_group_rating_xp_next(p.id, c.id) as nxt
            from profiles p
           cross join (select id from courses where published union all select null::uuid) c(id)
           where p.status = 'active' and p.archived_at is null
        ) v;
      drop function pg_temp.user_group_rating_xp_next(uuid, uuid);
    end if;

    if _pairs = 0 then
      raise exception 'ABORT: % - self-test compared nothing', r.name;
    end if;
    if _bad > 0 then
      raise exception 'ABORT: % - % of % (student, course) pairs differ where the rule says they must not',
        r.name, _bad, _pairs;
    end if;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % - stored definition differs from what was executed', r.name;
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % - owner, ACL or SECURITY DEFINER changed', r.name;
    end if;

    _stats := _stats || jsonb_build_object(r.name, jsonb_build_object('pairs', _pairs, 'floored', _floored));
  end loop;

  -- The website helper: signed-in users and the service role only (asserted, not assumed).
  if has_function_privilege('anon', 'public.group_rating_course_id(uuid)', 'EXECUTE') then
    raise exception 'ABORT: anon can EXECUTE group_rating_course_id';
  end if;
  if not has_function_privilege('authenticated', 'public.group_rating_course_id(uuid)', 'EXECUTE') then
    raise exception 'ABORT: authenticated cannot EXECUTE group_rating_course_id';
  end if;

  if not exists (select 1 from public.admin_actions where action = 'rating_course_scope_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'rating_course_scope_applied', jsonb_build_object(
      'migration', '20260929192010',
      'rewritten', _stats,
      'helpers', jsonb_build_array('user_course_join_floor(uuid,uuid)', 'group_rating_course_id(uuid)'),
      'at', now()));
  end if;
end $$;
