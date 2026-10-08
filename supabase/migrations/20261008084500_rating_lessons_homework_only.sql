-- Challenge 6.0: the rating counts ONLY watched lessons and homework (owner, 2026-10-08: "the students are taking it
-- too seriously and spending too much time setting it up … the only thing we give points for is homework and the
-- points earned from watching lessons — that is what everybody should be focusing on").
--
-- 1. RATING. platform_settings.rating_mode.content_only_course_ids lists the courses whose group rating is content
--    only: lesson_complete (+20) + homework_submit (+15) + homework_high_score (+25, grade >= 9), and only for lessons /
--    assignments of THAT course. Everything else (daily_active, streaks, community_*, challenge_* — extra tasks, chat,
--    questions, answers, group media, Instagram) stays in xp_events but no longer counts in the rating. Reversible:
--    drop the course from the list and the old rating is back, nothing was deleted.
--      user_group_rating_xp / user_group_rating_xp_since feed every student rank: group_leaderboard, profile_stats
--      .group_rank, group_student_leaderboard, the Leaderboard weekly tab, post_group_weekly_boards and
--      freeze_challenge_week (the weekly prize snapshot). Their live bodies (md5-pinned) move unchanged to *_all, and
--      the original names become a switch: content-only course → user_course_content_xp_since, else → *_all.
--      challenge_team_board summed raw xp_events of every reason; it gets the same content-only filter.
--    5.0 and every other course: byte-identical behaviour (not in the list → *_all = the old body).
--
-- 2. KILL-SWITCHES (config only, every engine stays installed and can be switched back on): see section 2 below.

-- ── 1a. config + helpers ─────────────────────────────────────────────────────────────────────────────────────────
insert into public.platform_settings (key, value, updated_at)
values ('rating_mode', jsonb_build_object('content_only_course_ids', jsonb_build_array('f502f631-2104-4834-b6c2-702cd3080e27')), now())
on conflict (key) do update set value = excluded.value, updated_at = now();

create or replace function public.rating_content_only(_course_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  -- TRUE when this course's group rating counts lessons + homework only (platform_settings.rating_mode).
  select _course_id is not null and coalesce((
    select (ps.value -> 'content_only_course_ids') ? _course_id::text
    from public.platform_settings ps
    where ps.key = 'rating_mode' and jsonb_typeof(ps.value -> 'content_only_course_ids') = 'array'
  ), false);
$function$;

create or replace function public.xp_event_is_course_content(_reason text, _ref_key text, _course_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  -- A lesson / homework XP event whose lesson / assignment belongs to _course_id (ref_key = '<prefix>:<uuid>').
  select case
    when _course_id is null or split_part(coalesce(_ref_key, ''), ':', 2) !~* '^[0-9a-f-]{36}$' then false
    when _reason = 'lesson_complete' then exists (
      select 1 from public.lessons l join public.modules m on m.id = l.module_id
      where l.id = split_part(_ref_key, ':', 2)::uuid and m.course_id = _course_id)
    when _reason in ('homework_submit', 'homework_high_score') then exists (
      select 1 from public.homework_assignments a join public.modules m on m.id = a.module_id
      where a.id = split_part(_ref_key, ':', 2)::uuid and m.course_id = _course_id)
    else false
  end;
$function$;

create or replace function public.user_course_content_xp_since(_uid uuid, _course_id uuid, _since timestamptz default null)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  -- Points from watching this course's lessons and doing its homework (all time when _since is null).
  select coalesce(sum(e.amount), 0)::int
  from public.xp_events e
  where e.user_id = _uid
    and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
    and (_since is null or e.created_at >= _since)
    and public.xp_event_is_course_content(e.reason, e.ref_key, _course_id);
$function$;

revoke execute on function public.rating_content_only(uuid) from public, anon, authenticated;
revoke execute on function public.xp_event_is_course_content(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.user_course_content_xp_since(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.rating_content_only(uuid) to service_role;
grant execute on function public.xp_event_is_course_content(text, text, uuid) to service_role;
grant execute on function public.user_course_content_xp_since(uuid, uuid, timestamptz) to service_role;

-- ── 1b. move the live rating bodies to *_all (md5-pinned), then make the old names a switch ──────────────────────
do $mig$
declare
  _def text;
  _md5 text;
begin
  if to_regprocedure('public.user_group_rating_xp_all(uuid,uuid)') is null then
    _def := pg_get_functiondef('public.user_group_rating_xp(uuid,uuid)'::regprocedure);
    _md5 := md5(_def);
    if _md5 <> '72535ddca72eb8c12390dfba26192036' then
      raise exception 'user_group_rating_xp drifted (md5 %), refusing to rewrite', _md5;
    end if;
    if (length(_def) - length(replace(_def, 'FUNCTION public.user_group_rating_xp(', ''))) / length('FUNCTION public.user_group_rating_xp(') <> 1 then
      raise exception 'user_group_rating_xp: header snippet not unique';
    end if;
    execute replace(_def, 'FUNCTION public.user_group_rating_xp(', 'FUNCTION public.user_group_rating_xp_all(');
  else
    raise notice 'user_group_rating_xp_all already exists (replay) — skipped';
  end if;

  if to_regprocedure('public.user_group_rating_xp_since_all(uuid,uuid,timestamptz)') is null then
    _def := pg_get_functiondef('public.user_group_rating_xp_since(uuid,uuid,timestamptz)'::regprocedure);
    _md5 := md5(_def);
    if _md5 <> '3f881230ed62bb599616e2c243fcbb60' then
      raise exception 'user_group_rating_xp_since drifted (md5 %), refusing to rewrite', _md5;
    end if;
    if (length(_def) - length(replace(_def, 'FUNCTION public.user_group_rating_xp_since(', ''))) / length('FUNCTION public.user_group_rating_xp_since(') <> 1 then
      raise exception 'user_group_rating_xp_since: header snippet not unique';
    end if;
    execute replace(_def, 'FUNCTION public.user_group_rating_xp_since(', 'FUNCTION public.user_group_rating_xp_since_all(');
  else
    raise notice 'user_group_rating_xp_since_all already exists (replay) — skipped';
  end if;
end
$mig$;

revoke execute on function public.user_group_rating_xp_all(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.user_group_rating_xp_since_all(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.user_group_rating_xp_all(uuid, uuid) to service_role;
grant execute on function public.user_group_rating_xp_since_all(uuid, uuid, timestamptz) to service_role;

-- CREATE OR REPLACE keeps the existing grants (authenticated + service_role) of the two public names.
create or replace function public.user_group_rating_xp(_uid uuid, _course_id uuid)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  -- 20261008084500: a content-only course (platform_settings.rating_mode) rates lessons + homework of that course;
  -- every other course keeps the full rating (user_group_rating_xp_all = the body before this migration).
  select case
    when public.rating_content_only(_course_id) then public.user_course_content_xp_since(_uid, _course_id, null)
    else public.user_group_rating_xp_all(_uid, _course_id)
  end;
$function$;

create or replace function public.user_group_rating_xp_since(_uid uuid, _course_id uuid, _since timestamp with time zone)
returns integer
language sql
stable security definer
set search_path to 'public'
as $function$
  -- 20261008084500: see user_group_rating_xp.
  select case
    when public.rating_content_only(_course_id) then public.user_course_content_xp_since(_uid, _course_id, _since)
    else public.user_group_rating_xp_since_all(_uid, _course_id, _since)
  end;
$function$;

-- The two public names keep exactly the grants they had (authenticated + service_role): the Leaderboard weekly tab
-- and the home screen call them with the student's own session. Restated explicitly (PUBLIC first, then re-grant).
revoke execute on function public.user_group_rating_xp(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.user_group_rating_xp_since(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.user_group_rating_xp(uuid, uuid) to authenticated, service_role;
grant execute on function public.user_group_rating_xp_since(uuid, uuid, timestamptz) to authenticated, service_role;

-- ── 1c. team board: the same content-only filter (md5-pinned) ───────────────────────────────────────────────────
do $mig$
declare
  _def text := pg_get_functiondef('public.challenge_team_board(timestamptz,timestamptz)'::regprocedure);
  _old text := E'  left join xp_events x on x.user_id = m.user_id and x.created_at >= _from and x.created_at < _to\n';
  _new text := E'  left join xp_events x on x.user_id = m.user_id and x.created_at >= _from and x.created_at < _to\n'
            || E'    and (not public.rating_content_only(g.course_id) or public.xp_event_is_course_content(x.reason, x.ref_key, g.course_id))\n';
begin
  if position('rating_content_only' in _def) > 0 then
    raise notice 'challenge_team_board already content-aware (replay) — skipped';
    return;
  end if;
  if md5(_def) <> '3477111f06a65152a71c00860f87f37c' then
    raise exception 'challenge_team_board drifted (md5 %), refusing to rewrite', md5(_def);
  end if;
  if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 1 then
    raise exception 'challenge_team_board: join snippet not unique';
  end if;
  execute replace(_def, _old, _new);
end
$mig$;

-- The home screen (Dashboard.tsx) asks whether the student's course is content-only, to show the rating points
-- instead of lifetime XP. It reads one public setting and no user data, so signed-in users may call it.
grant execute on function public.rating_content_only(uuid) to authenticated;

-- ── 2. kill-switches: nothing but lessons + homework earns points in Challenge 6.0 ───────────────────────────────
-- Verified against the live function bodies (2026-10-08):
--  * challenge_tasks.enabled=false → challenge_tasks_config().active=false: the tick, worker, receipts, AI checks,
--    week approval, capture (bot + Mini App) and reconciler all stop; their watchdogs log 'inactive' and stay quiet;
--    the bot ignores posts in the daily topics (no reply). Sub-flags are left as they are, so one flip re-enables.
--  * ig_handle_reminder.enabled=false → challenge_ig_handle_reminder() skips; its crons keep stamping the watchdog
--    state (do NOT unschedule them — the GitHub verifier would see a stale watchdog).
--  * challenge.qa.mode='off' → no judging (no AI spend), no challenge_answer / challenge_question awards.
--    points.group_media=0 → reconcile_challenge_xp skips the media insert (media_off, no 0-amount row, no crash).
--    answer/question/ig_post=0 are redundant belts. challenge.enabled stays TRUE (weekly freeze + team board +
--    the community-XP suppression in 6.0 groups) and retro_credit stays ON (turning it off leaves messages
--    unattached and trips challenge_retro_credit_watchdog R3; with every signal off it pays nothing).
update public.platform_settings
   set value = jsonb_set(value, '{enabled}', 'false'::jsonb), updated_at = now()
 where key = 'challenge_tasks';

update public.platform_settings
   set value = jsonb_set(value, '{enabled}', 'false'::jsonb), updated_at = now()
 where key = 'ig_handle_reminder';

update public.platform_settings
   set value = jsonb_set(
                 jsonb_set(value, '{qa,mode}', '"off"'::jsonb),
                 '{points}',
                 coalesce(value -> 'points', '{}'::jsonb)
                   || jsonb_build_object('group_media', 0, 'answer', 0, 'question', 0, 'ig_post', 0, 'chat', 0)),
       updated_at = now()
 where key = 'challenge';

-- ── 3. self-test (read-only: STABLE reads and settings, nothing is called that writes) ───────────────────────────
do $test$
declare
  _c uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _u uuid;
  _o record;
begin
  if not public.rating_content_only(_c) then raise exception 'selftest: 6.0 is not content-only'; end if;
  if public.rating_content_only(null) then raise exception 'selftest: null course is content-only'; end if;

  -- a 6.0 student: the rating is exactly their 6.0 lesson + homework points
  select p.id into _u from public.profiles p join public.groups g on g.id = p.group_id
   where g.course_id = _c and exists (select 1 from public.xp_events e where e.user_id = p.id and e.reason = 'lesson_complete')
   limit 1;
  if _u is not null and public.user_group_rating_xp(_u, _c) <> public.user_course_content_xp_since(_u, _c, null) then
    raise exception 'selftest: 6.0 rating is not content-only for %', _u;
  end if;

  -- a student of another course: byte-identical to the old body
  select p.id as uid, g.course_id as cid into _o from public.profiles p join public.groups g on g.id = p.group_id
   where g.course_id is not null and g.course_id <> _c
     and exists (select 1 from public.xp_events e where e.user_id = p.id)
   limit 1;
  if _o.uid is not null then
    if public.user_group_rating_xp(_o.uid, _o.cid) <> public.user_group_rating_xp_all(_o.uid, _o.cid)
       or public.user_group_rating_xp_since(_o.uid, _o.cid, now() - interval '7 days')
          <> public.user_group_rating_xp_since_all(_o.uid, _o.cid, now() - interval '7 days') then
      raise exception 'selftest: rating of another course changed for %', _o.uid;
    end if;
  end if;

  perform * from public.challenge_team_board(now() - interval '7 days', now());

  if (select (value ->> 'enabled')::boolean from public.platform_settings where key = 'challenge_tasks') is distinct from false
     or (select value #>> '{qa,mode}' from public.platform_settings where key = 'challenge') is distinct from 'off'
     or (select (value #>> '{points,group_media}')::int from public.platform_settings where key = 'challenge') <> 0 then
    raise exception 'selftest: kill-switches not set';
  end if;
end
$test$;
