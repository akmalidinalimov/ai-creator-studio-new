-- Multi-course students, PR 2 of 4: the teacher side (owner, 2026-11-27: "do PR#2").
--
-- PR 1 (20261127143100) lets a student be in a SECOND course (student_course_groups, non-main row) while their main
-- group stays profiles.group_id. Every teacher-side function still found the student's group through profiles.group_id,
-- so the second course's teacher could not see, grade, be notified about or reopen that student's homework, and the
-- health checks blamed the main group.
--
-- ONE rule, used everywhere below — a homework belongs to the student's group IN THE TASK'S COURSE, else (no group in
-- that course: an old course's task, today's behaviour) to their main group:
--   student_group_for_course(uid, course)        the secondary group of that course, else profiles.group_id
--   homework_group_for_submission(id)            the same, for a submission (course = assignment → module → course)
--   is_teacher_of_homework(student, assignment, teacher)   is the teacher a teacher of that group
-- For every student with no secondary course (all but 2 today) the rule returns profiles.group_id: nothing changes
-- for them (asserted on every existing submission by the self-test).
--
-- Access (RLS on homework_submissions, "hws own select" / "hws own update"): a teacher reads and grades a submission
-- when they teach THE SUBMISSION'S group — is_teacher_of(user_id, …) → is_teacher_of_homework(user_id, assignment_id, …).
-- is_teacher_of itself is NOT widened (security review: a secondary course's teacher must not reach the student's
-- main-course work, nor the other way round). Same result as before for every single-course student.
--
-- Patched (live bodies, md5-pinned, each pattern asserted to match exactly as often as it did on 2026-11-27):
--   teacher_pending_submissions     the grading queue: group = the task course's group (filter + group_id/name output)
--   teacher_groups                  its "pend" badge = the queue's rule again (20260930182000 keeps them equal)
--   reconcile_teacher_dm_queue      teacher DM re-queue goes to the task course's group teachers (both passes)
--   start_homework_resubmission     a teacher may reopen work of the task course's group
--   homework_pending_count_for_user a teacher's pending count follows the same group
--   student_assignable_homework     the website/Mini App task picker also offers the secondary courses' tasks
--   cross_course_health             a second-course task is no longer "another course's work" for a 2-course student
--   teacherless_homework_health     a secondary student counts in that group; their homework in a teacherless group
--                                   is flagged (CLAUDE STUDIO has no teacher yet — that alert is the point)
--   grading_sla_watchdog            overdue work is attributed to the task course's group
-- Not here (by plan): the bot's own grading lists / gs:open and capture (PR 3 — until then a secondary teacher's
-- re-queued DM button answers "not found"; nobody is affected today, CLAUDE STUDIO has no teacher), submit-homework's
-- instant teacher DM and hw_dm_fallback_deliver (PR 4), member lists (PR 4), hw_dm_health_stats (PR 3).
-- Replay-safe: a body already carrying the marker /* multi-course PR2 */ is skipped; ALTER POLICY is idempotent.

-- ── the rule ──
create or replace function public.student_group_for_course(_uid uuid, _course uuid)
returns uuid language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select coalesce(
    (select s.group_id from public.student_course_groups s
      where s.user_id = _uid and s.course_id = _course and not s.is_main),
    (select p.group_id from public.profiles p where p.id = _uid));
$function$;
revoke execute on function public.student_group_for_course(uuid, uuid) from public, anon, authenticated;
grant execute on function public.student_group_for_course(uuid, uuid) to service_role;

create or replace function public.homework_group_for_submission(_sid uuid)
returns uuid language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select coalesce(
    (select public.student_group_for_course(hs.user_id, m.course_id)
       from public.homework_submissions hs
       join public.homework_assignments a on a.id = hs.assignment_id
       join public.modules m on m.id = a.module_id
      where hs.id = _sid),
    -- a task row that cannot be resolved falls back to the main group (never NULL into a teacher check)
    (select p.group_id from public.homework_submissions hs join public.profiles p on p.id = hs.user_id where hs.id = _sid));
$function$;
revoke execute on function public.homework_group_for_submission(uuid) from public, anon, authenticated;
grant execute on function public.homework_group_for_submission(uuid) to service_role;

-- RLS helper: evaluated per row as the querying user → authenticated needs EXECUTE. It answers ONLY about the caller
-- (_teacher = auth.uid()) or for service_role, so it can never be used as an oracle on other people's memberships
-- (security review); the policies always pass auth.uid().
create or replace function public.is_teacher_of_homework(_student uuid, _assignment uuid, _teacher uuid)
returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select (_teacher = auth.uid() or auth.role() = 'service_role') and coalesce(public.is_group_teacher(
           coalesce(public.student_group_for_course(_student,
                      (select m.course_id from public.homework_assignments a
                         join public.modules m on m.id = a.module_id where a.id = _assignment)),
                    (select p.group_id from public.profiles p where p.id = _student)),
           _teacher), false);
$function$;
revoke execute on function public.is_teacher_of_homework(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_teacher_of_homework(uuid, uuid, uuid) to authenticated, service_role;

-- (the two homework_submissions policies are altered at the very END of this file — see there)

-- ── the patcher (session-local) ──
create or replace function pg_temp.mc2_patch(_fn regprocedure, _md5 text, _pats text[], _reps text[], _counts int[])
returns text language plpgsql as $function$
declare
  _src text;
  _def text;
  _i int;
  _n int;
begin
  select prosrc into _src from pg_proc where oid = _fn;
  if position('/* multi-course PR2 */' in _src) > 0 then
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
  if position('/* multi-course PR2 */' in _def) = 0 then
    raise exception '%: patched text carries no marker', _fn;
  end if;
  execute _def;  -- CREATE OR REPLACE: owner, grants and SECURITY DEFINER are kept
  return _fn::text || ': patched';
end
$function$;

do $patch$
declare _log jsonb := '[]'::jsonb;
begin
  _log := _log || to_jsonb(pg_temp.mc2_patch('public.teacher_pending_submissions(uuid,uuid)'::regprocedure,
    'f9576555057f74b4c44a0b98da05d4ea',
    array['p\.group_id(\s+)as group_id,',
          'join groups g\s+on g\.id = p\.group_id[^\n]*\n',
          '(join modules m\s+on m\.id = ha\.module_id[^\n]*\n)',
          'where p\.group_id in \(select public\.teacher_group_ids\(auth\.uid\(\)\)\)',
          'p_group_id is null or p\.group_id = p_group_id'],
    array[E'g.id\\1as group_id,',
          '',
          E'\\1  join groups g                on g.id = public.student_group_for_course(hs.user_id, m.course_id) /* multi-course PR2 */ -- the TASK course''s group, else the main group\n',
          'where g.id in (select public.teacher_group_ids(auth.uid()))',
          'p_group_id is null or g.id = p_group_id'],
    array[1, 1, 1, 1, 1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.teacher_groups(uuid)'::regprocedure,
    'bd7f37fa9b449c2612dd8282845efe12',
    array['select p\.group_id as gid, count\(\*\) as n\s*from homework_submissions hs\s*join profiles p on p\.id = hs\.user_id\s*join gs on gs\.id = p\.group_id\s*where \(hs\.score is null or hs\.score_is_stale is true\)\s*group by p\.group_id'],
    array[E'select x.gid, count(*) as n /* multi-course PR2 */ -- the queue''s rule: the task course''s group\n    from (select public.homework_group_for_submission(hs.id) as gid\n            from homework_submissions hs\n           where (hs.score is null or hs.score_is_stale is true)) x\n    join gs on gs.id = x.gid\n    group by x.gid'],
    array[1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.reconcile_teacher_dm_queue()'::regprocedure,
    '85b8b6fa2c6e70988eae557c818baa21',
    array['\) g on g\.id = p\.group_id'],
    array[') g on g.id = public.homework_group_for_submission(hs.id) /* multi-course PR2 */'],
    array[2]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.start_homework_resubmission(uuid)'::regprocedure,
    '3f18878f182958092cea079cc4076a55',
    array['AND EXISTS \(\s*SELECT 1 FROM public\.profiles st\s*JOIN public\.groups g ON g\.id = st\.group_id\s*WHERE st\.id = v_row\.user_id AND public\.is_group_teacher\(st\.group_id, v_caller\)\s*\)'],
    array['AND public.is_group_teacher(public.homework_group_for_submission(v_row.id), v_caller) /* multi-course PR2 */'],
    array[1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.homework_pending_count_for_user(uuid)'::regprocedure,
    '6c5a29fb05278fabdddd6a1159e3c384',
    array['JOIN groups g ON g\.id = p\.group_id\s*WHERE s\.score IS NULL AND g\.id IN'],
    array['WHERE s.score IS NULL AND public.homework_group_for_submission(s.id) /* multi-course PR2 */ IN'],
    array[1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.student_assignable_homework()'::regprocedure,
    '749400b1bcd5533e171b06ed13ab794e',
    array['course_scope as \(\s*select course_id from group_course_published'],
    array[E'secondary_courses as ( /* multi-course PR2 */\n    -- the student''s SECONDARY courses (student_course_groups), published\n    select s.course_id from public.student_course_groups s\n    join public.courses c2 on c2.id = s.course_id\n    where s.user_id = v_caller and not s.is_main and c2.published = true\n  ),\n  course_scope as (\n    select course_id from secondary_courses\n    union all\n    select course_id from group_course_published'],
    array[1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.cross_course_health()'::regprocedure,
    'e93e3bdf882bdef86639fd1cba943efc',
    array['left join public\.groups g on g\.id = p\.group_id'],
    array['left join public.groups g on g.id = public.student_group_for_course(hs.user_id, m.course_id) /* multi-course PR2 */'],
    array[1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.teacherless_homework_health()'::regprocedure,
    '21754a5ebf6cfebca7f0aa2fdeeb3fab',
    array['where p\.group_id = g\.id and p\.archived_at is null',
          'select hs\.id, p\.group_id,',
          'left join grp gr on gr\.id = p\.group_id'],
    array['where (p.group_id = g.id or exists (select 1 from public.student_course_groups s where s.user_id = p.id and s.group_id = g.id and not s.is_main)) /* multi-course PR2 */ and p.archived_at is null',
          'select hs.id, public.homework_group_for_submission(hs.id) as group_id,',
          'left join grp gr on gr.id = public.homework_group_for_submission(hs.id)'],
    array[1, 1, 1]));

  _log := _log || to_jsonb(pg_temp.mc2_patch('public.grading_sla_watchdog()'::regprocedure,
    'fb61a292dba2ec0269782a8445105d68',
    array['join public\.groups g on g\.id = s\.group_id'],
    array['join public.groups g on g.id = public.homework_group_for_submission(h.id) /* multi-course PR2 */'],
    array[1]));

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'multi_course_teacher_side', jsonb_build_object('migration', '20261127180654', 'functions', _log));
end $patch$;

-- ── self-test (read-only) ──
-- 1. for every submission of a student with NO secondary course, the rule returns exactly their main group, and the
--    new RLS check agrees with the old one (is_teacher_of) for every teacher of that group: no behaviour change
-- 2. each secondary row resolves to its own group
-- 3. the patched PL/pgSQL bodies that are pure reads RUN their patched queries (plpgsql plans at run time):
--    cross_course_health, teacherless_homework_health, student_assignable_homework (as a secondary student) and
--    homework_pending_count_for_user (as service_role, for a teacher who is NOT an admin, so the patched branch runs).
--    The JWT claims are set inside a sub-block that ends by raising a sentinel, so the setting is rolled back with it
--    (a GUC set in a subtransaction is undone when it aborts). SQL-language bodies were validated by CREATE itself.
--    The writers (reconcile_teacher_dm_queue, start_homework_resubmission) and the DM-sending watchdog are NOT run.
do $test$
declare _bad int; _n int; _j jsonb; _uid uuid; _teacher uuid;
begin
  select count(*) into _bad
    from public.homework_submissions hs
    join public.profiles p on p.id = hs.user_id
   where not exists (select 1 from public.student_course_groups s where s.user_id = hs.user_id and not s.is_main)
     and public.homework_group_for_submission(hs.id) is distinct from p.group_id;
  if _bad <> 0 then
    raise exception 'self-test: % submission(s) of single-course students resolve to a non-main group', _bad;
  end if;

  select count(*) into _bad
    from public.student_course_groups s
   where not s.is_main and public.student_group_for_course(s.user_id, s.course_id) is distinct from s.group_id;
  if _bad <> 0 then
    raise exception 'self-test: % secondary row(s) do not resolve to their own group', _bad;
  end if;

  _j := public.cross_course_health();
  _j := public.teacherless_homework_health();

  begin
    -- the new homework access equals is_teacher_of for every single-course submission × teacher of their group
    -- (as service_role: the helper answers only about the caller otherwise)
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
    select count(*) into _bad
      from public.homework_submissions hs
      join public.profiles p on p.id = hs.user_id
      join (select g.id, g.teacher_id from public.groups g where g.teacher_id is not null
            union select gt.group_id, gt.teacher_id from public.group_teachers gt) t on t.id = p.group_id
     where not exists (select 1 from public.student_course_groups s where s.user_id = hs.user_id and not s.is_main)
       and public.is_teacher_of_homework(hs.user_id, hs.assignment_id, t.teacher_id)
           is distinct from public.is_teacher_of(hs.user_id, t.teacher_id);
    if _bad <> 0 then
      raise exception 'self-test: the new homework access disagrees with is_teacher_of on % single-course row(s)', _bad;
    end if;
    -- …and a plain signed-in caller gets "no" about someone else: a REAL pair the teacher does teach (answered "yes"
    -- just above as service_role) must now be "no"
    perform set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    if exists (select 1 from public.homework_submissions hs
                 join public.profiles p on p.id = hs.user_id
                 join public.groups g on g.id = p.group_id and g.teacher_id is not null
                where public.is_teacher_of(hs.user_id, g.teacher_id)
                  and public.is_teacher_of_homework(hs.user_id, hs.assignment_id, g.teacher_id)) then
      raise exception 'self-test: is_teacher_of_homework answered about another user';
    end if;

    select user_id into _uid from public.student_course_groups where not is_main order by added_at limit 1;
    if _uid is not null then
      perform set_config('request.jwt.claims', jsonb_build_object('sub', _uid, 'role', 'authenticated')::text, true);
      select count(*) into _n from public.student_assignable_homework();
    end if;
    select ur.user_id into _teacher from public.user_roles ur
     where ur.role = 'teacher'
       and not exists (select 1 from public.user_roles a where a.user_id = ur.user_id and a.role in ('admin', 'superadmin'))
     limit 1;
    if _teacher is not null then
      perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
      _n := public.homework_pending_count_for_user(_teacher);
    end if;
    raise exception 'mc2_selftest_rollback';
  exception when raise_exception then
    if sqlerrm <> 'mc2_selftest_rollback' then raise; end if;
  end;
end $test$;

-- ── homework_submissions access: LAST, so the table lock (held to commit) lasts a moment, not the whole file ──
-- ALTER POLICY in place: atomic (the table is never without its policy), keeps the command and roles ("hws own select"
-- FOR SELECT to PUBLIC, "hws own update" FOR UPDATE TO authenticated). Only is_teacher_of → is_teacher_of_homework.
alter policy "hws own select" on public.homework_submissions
  using ((auth.uid() = user_id) or has_role(auth.uid(), 'admin'::app_role)
         or (has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of_homework(user_id, assignment_id, auth.uid())));
alter policy "hws own update" on public.homework_submissions
  using (has_role(auth.uid(), 'admin'::app_role)
         or (has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of_homework(user_id, assignment_id, auth.uid())))
  with check (has_role(auth.uid(), 'admin'::app_role)
         or (has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of_homework(user_id, assignment_id, auth.uid())));
