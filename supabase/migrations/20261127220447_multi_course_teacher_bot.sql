-- Multi-course students, PR 3b: the teacher side of the Telegram bot (+ the "uncaptured homework" detector).
--
-- The bot's teacher screens (grading picker, roster, module views, open-by-id, retag) now place each homework in the
-- student's group IN THE TASK'S COURSE, else their main group (PR 2's rule, SQL homework_group_for_submission). That
-- part is TypeScript (telegram-bot-webhook/teacher-course-scope.ts + index.ts). This file patches the one SQL health
-- function the plan left for PR 3:
--
--   hw_dm_health_stats()
--     uncaptured_24h        a homework-topic media post is matched to the poster's group by profiles.group_id only,
--                           so a post in a SECONDARY course group's topic was never even looked at (blind spot, not a
--                           false alarm). Now the poster's group is their main group OR one of their secondary groups;
--                           a topic belongs to one group, so a post still joins at most the group whose topic it is.
--     stalest_capture_days  "how long since this active-course group last captured a topic homework". A secondary
--                           group's members now count for it; each submission counts only for ITS group (the task
--                           course's group, else the main group), so a 2-course student's work is never counted twice
--                           and their second-course work no longer keeps the MAIN group looking alive. For a student
--                           with no secondary course the extra condition is the not-exists fast path: unchanged.
--     misconfigured_groups  (the >= 3 members size threshold) deliberately left on main members.
--
-- Live body md5-pinned (76e06ddec1c3842335e0868fce117b49, 2026-11-27), every pattern asserted to match exactly once,
-- marker /* multi-course PR3b */ (replay = skipped). CREATE OR REPLACE keeps owner, grants and SECURITY DEFINER.
-- Self-test (read-only, sends nothing): the pre-patch body is kept as a session-local copy and both are evaluated in
-- ONE statement (same snapshot: both are STABLE); with no secondary-course topic work or posts — true on 2026-11-27
-- (2 secondary rows, 0 topic submissions, 0 posts) — uncaptured_24h and stalest_capture_days must be identical.

-- ── the patcher (session-local; mc2_patch of 20261127180654 with this PR's marker) ──
create or replace function pg_temp.mc3b_patch(_fn regprocedure, _md5 text, _pats text[], _reps text[], _counts int[])
returns text language plpgsql as $function$
declare
  _src text;
  _def text;
  _i int;
  _n int;
begin
  select prosrc into _src from pg_proc where oid = _fn;
  if position('/* multi-course PR3b */' in _src) > 0 then
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
  if position('/* multi-course PR3b */' in _def) = 0 then
    raise exception '%: patched text carries no marker', _fn;
  end if;
  execute _def;  -- CREATE OR REPLACE: owner, grants and SECURITY DEFINER are kept
  return _fn::text || ': patched';
end
$function$;

do $patch$
declare
  _already boolean := position('/* multi-course PR3b */' in
                        (select prosrc from pg_proc where oid = 'public.hw_dm_health_stats()'::regprocedure)) > 0;
  _res text;
  _before jsonb;
  _after jsonb;
  _sec_work boolean;
  _checked text;
begin
  if not _already then
    -- the pre-patch body, session-local, for the self-test below (the md5 pin in mc3b_patch guards the same text)
    execute regexp_replace(pg_get_functiondef('public.hw_dm_health_stats()'::regprocedure),
                           'FUNCTION public\.hw_dm_health_stats\(\)', 'FUNCTION pg_temp.hw_dm_health_stats_pre3b()');
  end if;

  _res := pg_temp.mc3b_patch('public.hw_dm_health_stats()'::regprocedure,
    '76e06ddec1c3842335e0868fce117b49',
    array['join groups g on p\.group_id = g\.id',
          'join profiles p on p\.group_id = g\.id\s*\n(\s*)join homework_submissions hs on hs\.user_id = p\.id and hs\.source = ''telegram_topic'''],
    array['join groups g on (p.group_id = g.id or exists (select 1 from public.student_course_groups s where s.user_id = p.id and s.group_id = g.id and not s.is_main)) /* multi-course PR3b */',
          E'join profiles p on (p.group_id = g.id or exists (select 1 from public.student_course_groups s where s.user_id = p.id and s.group_id = g.id and not s.is_main)) /* multi-course PR3b */\n\\1join homework_submissions hs on hs.user_id = p.id and hs.source = ''telegram_topic''\n\\1  -- multi-course PR3b: a student with a secondary course counts each submission only for ITS group\n\\1  and (not exists (select 1 from public.student_course_groups s2 where s2.user_id = p.id and not s2.is_main)\n\\1       or public.homework_group_for_submission(hs.id) = g.id)'],
    array[1, 1]);

  -- ── self-test (read-only) ──
  if _already then
    _checked := 'skipped_replay';
  else
    -- ONE statement: both functions are STABLE, so every query inside them reads this statement's snapshot
    select pg_temp.hw_dm_health_stats_pre3b(), public.hw_dm_health_stats(),
           exists (select 1 from public.student_course_groups s
                     join public.homework_submissions hs on hs.user_id = s.user_id and hs.source = 'telegram_topic'
                    where not s.is_main)
           or exists (select 1 from public.student_course_groups s
                        join public.profiles p on p.id = s.user_id
                        join public.groups g on g.id = s.group_id
                        join public.webhook_inbox w on w.from_user_id = p.telegram_id and w.message_thread_id = g.homework_topic_id
                       where not s.is_main and w.received_at > now() - interval '24 hours')
      into _before, _after, _sec_work;
    if _after is null or not (_after ? 'uncaptured_24h') or not (_after ? 'stalest_capture_days') then
      raise exception 'self-test: patched hw_dm_health_stats() returned %', _after;
    end if;
    if _sec_work then
      -- a secondary-course student already has topic work / posts: the two fields may legitimately differ now
      _checked := 'not_compared_secondary_topic_work';
    else
      if (_before->'uncaptured_24h') is distinct from (_after->'uncaptured_24h')
         or (_before->'stalest_capture_days') is distinct from (_after->'stalest_capture_days') then
        raise exception 'self-test: hw_dm_health_stats changed with no secondary topic work: before uncaptured=% stalest=%, after uncaptured=% stalest=%',
          _before->'uncaptured_24h', _before->'stalest_capture_days', _after->'uncaptured_24h', _after->'stalest_capture_days';
      end if;
      _checked := 'identical';
    end if;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'multi_course_teacher_bot', jsonb_build_object(
    'migration', '20261127220447', 'patch', _res, 'self_test', _checked,
    'before', jsonb_build_object('uncaptured_24h', _before->'uncaptured_24h', 'stalest_capture_days', _before->'stalest_capture_days'),
    'after', jsonb_build_object('uncaptured_24h', _after->'uncaptured_24h', 'stalest_capture_days', _after->'stalest_capture_days')));
end $patch$;
