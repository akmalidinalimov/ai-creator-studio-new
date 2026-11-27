-- Multi-course students, PR 1 of 4: the foundation (owner, 2026-11-27: "some students could be in 2 or 3 courses, we
-- need to be able to add the same user into multiple courses"; scope chosen: watch + homework per course, entry both
-- automatic (Telegram) and by admin, the first course stays the MAIN one for rating / boards / reminders).
--
-- Today a student has ONE group (profiles.group_id) and ~360 code paths read it. Access to videos is already per course
-- (enrollments + tier), but there was no way to say "also in group X of course B" without moving the student.
--
-- This migration:
--   1. student_course_groups(user_id, course_id, group_id, is_main, source): ONE group per (student, course). The main
--      row MIRRORS profiles.group_id (trigger trg_profiles_scg_mirror, so every existing writer — admin_assign_group,
--      the bot, admin-create-students — keeps it right by construction). Secondary rows are the extra courses.
--      Move semantics are unchanged: when profiles.group_id changes course, the main row FOLLOWS it (the old course's
--      row is not kept), exactly as a move behaves today; a secondary row of the new course becomes the main one.
--   2. add_student_course_group(uid, group, source, actor): the ONE engine that adds/changes a secondary course. Upserts
--      the row and the enrollment (the group's tier), audits student_course_added / _changed. Refuses the main course
--      (that is a move: admin_assign_group). Used by the admin RPC now, by the bot in PR 3.
--   3. admin_add_student_course(user_ids, group): admin-only RPC behind the new "Kursga qo'shish…" action in Admin →
--      Foydalanuvchilar. Per-student result; one failure never blocks the others.
--   4. enforce_enrollment_tier_from_group: the tier of a SECONDARY course's enrollment is dictated by that course's group,
--      as the main course's already is by profiles.group_id (rewritten from the LIVE body, md5-pinned, replay-safe).
--   5. Health: student_course_groups_health() + student_course_groups_watchdog() (:44 hourly) — DMs the admins when the
--      mirror drifts from profiles.group_id, a row's course no longer matches its group, or a secondary course has no
--      enrollment.
--   6. Heal: the non-staff students whose main course is another course and who are members of the CLAUDE STUDIO
--      chats (webhook_inbox chat_member since 2026-11-23; on 11-27 that is @byselam and @mlk_422, both 7.0) get
--      CLAUDE STUDIO as a second course, in the real group if they are in its chat, else the channel holding group.
--
-- Nothing else reads the new table yet: homework, teachers and the bot keep using profiles.group_id until PR 2 / PR 3,
-- so this PR changes no existing behaviour. A secondary student can watch the course on the website / Mini App
-- (Dashboard and lessons already read enrollments).
-- Order matters: the trigger on the hot profiles table is created LAST (its lock is held to commit), after a first
-- backfill and the heal; a second backfill right after it covers any group change in between, then the self-test.
-- An existing enrollment's tier in the added course is set to that group's tier (the group is authoritative, exactly as
-- sync_group_enrollment does for the main course).
-- (Supersedes the never-committed drafts 20261127141900 / 20261127142600 / 20261127143000: which wrote a text into admin_actions.target_resource_id — a
-- uuid column — and would have aborted at apply time; found in review.)

-- ── 1. table ──
create table if not exists public.student_course_groups (
  user_id    uuid not null references auth.users(id) on delete cascade,
  course_id  uuid not null references public.courses(id) on delete cascade,
  group_id   uuid not null references public.groups(id) on delete cascade,
  is_main    boolean not null default false,
  source     text not null default 'main',
  added_at   timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);
create unique index if not exists student_course_groups_one_main on public.student_course_groups (user_id) where is_main;
create index if not exists student_course_groups_group_idx on public.student_course_groups (group_id);

alter table public.student_course_groups enable row level security;
revoke all on table public.student_course_groups from public, anon, authenticated;
grant select on table public.student_course_groups to authenticated;
grant all on table public.student_course_groups to service_role;
drop policy if exists "scg own or admin select" on public.student_course_groups;
create policy "scg own or admin select" on public.student_course_groups for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::app_role)
         or public.has_role(auth.uid(), 'superadmin'::app_role));
-- no insert/update/delete policy: writes go through the SECURITY DEFINER engine / trigger / service_role only

-- the group must belong to the row's course (a hand-written course_id can never pair with another course's group)
create or replace function public.scg_check_group_course()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _c uuid;
begin
  select course_id into _c from public.groups where id = new.group_id;
  if _c is null or _c <> new.course_id then
    raise exception 'student_course_groups: group % is not in course %', new.group_id, new.course_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$function$;
revoke execute on function public.scg_check_group_course() from public, anon, authenticated;
drop trigger if exists trg_scg_check_group_course on public.student_course_groups;
create trigger trg_scg_check_group_course before insert or update on public.student_course_groups
  for each row execute function public.scg_check_group_course();

-- ── the main row mirrors profiles.group_id (the trigger itself is created at the end) ──
create or replace function public.scg_mirror_main_group()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _course uuid;
begin
  if tg_op = 'UPDATE' and new.group_id is not distinct from old.group_id then return new; end if;
  begin
    select course_id into _course from public.groups where id = new.group_id;
    if new.group_id is null or _course is null then
      delete from public.student_course_groups where user_id = new.id and is_main;
      return new;
    end if;
    -- a secondary row of the new main course is replaced by the main row
    delete from public.student_course_groups where user_id = new.id and course_id = _course and not is_main;
    update public.student_course_groups
       set course_id = _course, group_id = new.group_id, source = 'main', updated_at = now()
     where user_id = new.id and is_main;
    if not found then
      insert into public.student_course_groups (user_id, course_id, group_id, is_main, source)
      values (new.id, _course, new.group_id, true, 'main');
    end if;
  exception when others then
    -- never fail the student's group assignment over the mirror; the drift is caught by student_course_groups_health
    raise warning 'scg_mirror_main_group(%): %', new.id, sqlerrm;
  end;
  return new;
end
$function$;
revoke execute on function public.scg_mirror_main_group() from public, anon, authenticated;

-- first backfill of the main rows (idempotent)
insert into public.student_course_groups (user_id, course_id, group_id, is_main, source)
select p.id, g.course_id, p.group_id, true, 'main'
  from public.profiles p join public.groups g on g.id = p.group_id
 where g.course_id is not null
on conflict (user_id, course_id) do update
  set group_id = excluded.group_id, is_main = true, source = 'main', updated_at = now();

-- ── 4. tier of a secondary course's enrollment comes from that course's group ──
do $pin$
declare _src text := (select prosrc from pg_proc where oid = 'public.enforce_enrollment_tier_from_group()'::regprocedure);
begin
  if position('20261127143100' in _src) > 0 then
    return;  -- already this version (a replay)
  end if;
  if md5(_src) <> 'feaf5dac43b2820ae3229a3a6b78556a' then
    raise exception 'enforce_enrollment_tier_from_group changed since it was reviewed (2026-11-27) — refusing to overwrite';
  end if;
end $pin$;

create or replace function public.enforce_enrollment_tier_from_group()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  _grp_course uuid;
  _grp_tier uuid;
  _sec_tier uuid;
begin
  -- 1) The student's own group course is dictated by the group's tier.
  select g.course_id, g.tier_id into _grp_course, _grp_tier
    from public.profiles p join public.groups g on g.id = p.group_id
   where p.id = new.user_id;
  if _grp_course is not null and _grp_course = new.course_id then
    new.tier_id := _grp_tier;
  else
    -- 1b) 20261127143100: a SECONDARY course (student_course_groups) is dictated by that course's group's tier.
    select g.tier_id into _sec_tier
      from public.student_course_groups s join public.groups g on g.id = s.group_id
     where s.user_id = new.user_id and s.course_id = new.course_id and not s.is_main;
    if found then
      new.tier_id := _sec_tier;
    end if;
  end if;
  -- 2) Hard safeguard: a tiered course requires an explicit tier — for
  -- STUDENTS. Staff (teacher/admin/superadmin) enroll tierless: their
  -- access is role-based (has_module_access bypass), tiers don't apply.
  if new.tier_id is null
     and exists (select 1 from public.course_tiers ct where ct.course_id = new.course_id)
     and not (
       public.has_role(new.user_id, 'teacher'::app_role)
       or public.has_role(new.user_id, 'admin'::app_role)
       or public.has_role(new.user_id, 'superadmin'::app_role)
     ) then
    raise exception 'tierless enrollment into tiered course % is not allowed — assign the student to a group (or pass a tier)', new.course_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_enrollment_tier_from_group() from public, anon, authenticated;

-- ── 2. the engine ──
create or replace function public.add_student_course_group(_uid uuid, _group uuid, _source text, _actor uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _course uuid;
  _tier uuid;
  _main_course uuid;
  _prev uuid;
  _status text;
  _n int;
begin
  select course_id, tier_id into _course, _tier from public.groups where id = _group;
  if _course is null then
    return jsonb_build_object('status', 'bad_group', 'user_id', _uid);
  end if;
  if not exists (select 1 from public.profiles where id = _uid) then
    return jsonb_build_object('status', 'no_profile', 'user_id', _uid);
  end if;
  select g.course_id into _main_course
    from public.profiles p join public.groups g on g.id = p.group_id where p.id = _uid;
  if _main_course = _course then
    -- their main course already: changing that group is a MOVE (admin_assign_group), never done here
    return jsonb_build_object('status', 'main_course', 'user_id', _uid, 'course_id', _course);
  end if;

  select group_id into _prev from public.student_course_groups where user_id = _uid and course_id = _course;
  if _prev = _group then
    _status := 'already';
  else
    insert into public.student_course_groups (user_id, course_id, group_id, is_main, source)
    values (_uid, _course, _group, false, coalesce(nullif(_source, ''), 'unknown'))
    on conflict (user_id, course_id) do update
      set group_id = excluded.group_id, source = excluded.source, updated_at = now()
      where not public.student_course_groups.is_main;
    get diagnostics _n = row_count;
    if _n = 0 then
      -- a main row of this course appeared concurrently: it is their main course now
      return jsonb_build_object('status', 'main_course', 'user_id', _uid, 'course_id', _course);
    end if;
    _status := case when _prev is null then 'added' else 'changed' end;
  end if;

  -- the enrollment (the BEFORE trigger sets the tier from the secondary group); also repairs an 'already' row
  insert into public.enrollments (user_id, course_id, tier_id) values (_uid, _course, _tier)
  on conflict (user_id, course_id) do update set tier_id = excluded.tier_id;

  if _status <> 'already' then
    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (_actor, case when _status = 'added' then 'student_course_added' else 'student_course_changed' end,
            _uid, 'group', _group,
            jsonb_build_object('course_id', _course, 'group_id', _group, 'previous_group_id', _prev, 'source', _source));
  end if;
  return jsonb_build_object('status', _status, 'user_id', _uid, 'course_id', _course, 'group_id', _group);
end
$function$;
revoke execute on function public.add_student_course_group(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.add_student_course_group(uuid, uuid, text, uuid) to service_role;

-- ── 3. admin RPC ──
create or replace function public.admin_add_student_course(_user_ids uuid[], _group_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _me uuid := auth.uid();
  _u uuid;
  _r jsonb;
  _results jsonb := '[]'::jsonb;
begin
  if _me is null or not (public.has_role(_me, 'admin'::app_role) or public.has_role(_me, 'superadmin'::app_role)) then
    raise exception 'forbidden';
  end if;
  -- a course's channel holding group («… | KANAL») is filled by the bot for channel-only members, never by hand
  if exists (select 1 from public.courses where channel_group_id = _group_id) then
    raise exception 'holding_group: pick a real group of the course, not its channel holding group';
  end if;
  foreach _u in array coalesce(_user_ids, '{}'::uuid[]) loop
    begin
      _r := public.add_student_course_group(_u, _group_id, 'admin', _me);
    exception when others then
      _r := jsonb_build_object('status', 'error', 'user_id', _u, 'error', left(sqlerrm, 200));
    end;
    _results := _results || jsonb_build_array(_r);
  end loop;
  return jsonb_build_object(
    'added',       (select count(*) from jsonb_array_elements(_results) x where x->>'status' in ('added', 'changed')),
    'already',     (select count(*) from jsonb_array_elements(_results) x where x->>'status' = 'already'),
    'main_course', (select count(*) from jsonb_array_elements(_results) x where x->>'status' = 'main_course'),
    'failed',      (select count(*) from jsonb_array_elements(_results) x where x->>'status' not in ('added', 'changed', 'already', 'main_course')),
    'first_error', (select x->>'error' from jsonb_array_elements(_results) x where x->>'status' = 'error' limit 1),
    'results', _results);
end
$function$;
revoke execute on function public.admin_add_student_course(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.admin_add_student_course(uuid[], uuid) to authenticated, service_role;

-- ── 5. health + watchdog ──
create or replace function public.student_course_groups_health()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select jsonb_build_object(
    -- a student whose group (with a course) has no matching main row
    'main_missing', (select count(*) from public.profiles p join public.groups g on g.id = p.group_id
                      where g.course_id is not null
                        and not exists (select 1 from public.student_course_groups s
                                         where s.user_id = p.id and s.is_main and s.group_id = p.group_id)),
    -- a main row that no longer matches profiles.group_id
    'main_stale', (select count(*) from public.student_course_groups s join public.profiles p on p.id = s.user_id
                    where s.is_main and s.group_id is distinct from p.group_id),
    -- a row whose group was moved to another course since (groups.course_id changed)
    'course_stale', (select count(*) from public.student_course_groups s join public.groups g on g.id = s.group_id
                      where g.course_id is distinct from s.course_id),
    -- a secondary course without its enrollment (no access to the course they were added to)
    'secondary_unenrolled', (select count(*) from public.student_course_groups s
                              where not s.is_main
                                and not exists (select 1 from public.enrollments e
                                                 where e.user_id = s.user_id and e.course_id = s.course_id)),
    'secondary_rows', (select count(*) from public.student_course_groups where not is_main),
    'checked_at', now());
$function$;
revoke execute on function public.student_course_groups_health() from public, anon, authenticated;
grant execute on function public.student_course_groups_health() to service_role;

create or replace function public.student_course_groups_watchdog()
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _h jsonb;
  _err text;
  _bad int;
  _sig text;
  _prev jsonb := (select value from public.app_settings where key = 'student_course_groups_watchdog_state');
  _prev_sig text := coalesce(_prev->>'notified_sig', '0/0/0/0');
  _action text := 'none';
  _tok text;
  _admin record;
  _dm int := 0;
  _msg text;
begin
  begin
    _h := public.student_course_groups_health();
    _bad := (_h->>'main_missing')::int + (_h->>'main_stale')::int + (_h->>'course_stale')::int
            + (_h->>'secondary_unenrolled')::int;
    _sig := (_h->>'main_missing') || '/' || (_h->>'main_stale') || '/' || (_h->>'course_stale') || '/'
            || (_h->>'secondary_unenrolled');
  exception when others then
    -- a health check we cannot read is itself an alarm, never a quiet "fine"
    _err := left(sqlerrm, 200);
    _h := jsonb_build_object('error', _err);
    _bad := 1;
    _sig := 'unreadable';
  end;
  if _sig <> _prev_sig then
    _action := case when _bad > 0 then 'alert' else 'recovered' end;
  end if;
  if _action <> 'none' then
    _msg := case
      when _err is not null then '⚠️ student_course_groups_health() ishlamayapti: ' || _err
      when _action = 'alert'
      then '⚠️ Talaba–kurs guruhlari mos emas: asosiy guruh yozuvi yo''q ' || (_h->>'main_missing')
           || ', eskirgan ' || (_h->>'main_stale') || ', kursi o''zgargan guruh ' || (_h->>'course_stale')
           || ', qo''shimcha kursga yozilmagan ' || (_h->>'secondary_unenrolled')
           || E'.\nTekshiring: student_course_groups_health().'
      else '✅ Talaba–kurs guruhlari yana mos.'
    end;
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active'
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'student_course_groups_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
    -- DB-visible row: every delivered alert/recovery, and an undelivered one only when its signature is new
    if _dm > 0 or (_prev->>'undelivered_sig') is distinct from _sig then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, case when _action = 'alert' then 'student_course_groups_ALARM' else 'student_course_groups_recovered' end,
                _h || jsonb_build_object('dm_attempted', _dm));
      exception when others then null; end;
    end if;
  end if;
  insert into public.app_settings (key, value)
  values ('student_course_groups_watchdog_state', jsonb_build_object(
    'notified_sig', case when _action = 'none' or _dm > 0 then _sig else _prev_sig end,
    'undelivered_sig', case when _action <> 'none' and _dm = 0 then _sig end,
    'last', _h, 'last_action', _action, 'dm_attempted_last_run', _dm, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  return _h || jsonb_build_object('action', _action, 'dm_attempted', _dm);
end
$function$;
revoke execute on function public.student_course_groups_watchdog() from public, anon, authenticated;
grant execute on function public.student_course_groups_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'student-course-groups-watchdog') then
    perform cron.unschedule('student-course-groups-watchdog');
  end if;
  perform cron.schedule('student-course-groups-watchdog', '44 * * * *', $cmd$ select public.student_course_groups_watchdog() $cmd$);
end $$;

-- ── 6. heal: 7.0 students who are members of the CLAUDE STUDIO chats get CLAUDE STUDIO as a second course ──
do $heal$
declare
  _c constant uuid := '36e79750-6dd6-4f1d-ac6f-c74c7237ec86';
  _real uuid;
  _hold uuid;
  _r record;
  _res jsonb;
  _done jsonb := '[]'::jsonb;
begin
  select id into _real from public.groups where course_id = _c and name = 'CLAUDE STUDIO | 1 - GURUH';
  select channel_group_id into _hold from public.courses where id = _c;
  if _real is null or _hold is null then
    raise notice 'CLAUDE STUDIO groups not found — heal skipped';
    return;
  end if;
  for _r in
    with ev as (
      select distinct on (tg, chat) tg, chat, st from (
        select (raw_update->'chat_member'->'new_chat_member'->'user'->>'id')::bigint tg,
               (raw_update->'chat_member'->'chat'->>'id')::bigint chat,
               raw_update->'chat_member'->'new_chat_member'->>'status' st, id
          from public.webhook_inbox
         where received_at > '2026-11-23'           -- the chats were created on 11-23 (bounded scan)
           and update_type = 'unknown' and raw_update ? 'chat_member'
           and (raw_update->'chat_member'->'chat'->>'id')::bigint in (-1004450754958, -1004481103852)) x
      order by tg, chat, id desc)
    select p.id uid, bool_or(ev.chat = -1004481103852) in_group
      from ev join public.profiles p on p.telegram_id = ev.tg
      join public.groups mg on mg.id = p.group_id
     where ev.st in ('member', 'restricted') and mg.course_id is distinct from _c
       and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
     group by p.id
  loop
    begin
      _res := public.add_student_course_group(_r.uid, case when _r.in_group then _real else _hold end, 'heal_chat_member', null);
    exception when others then
      _res := jsonb_build_object('status', 'error', 'user_id', _r.uid, 'error', left(sqlerrm, 200));
    end;
    _done := _done || jsonb_build_array(_res);
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'student_course_groups_heal', jsonb_build_object('migration', '20261127143100', 'course_id', _c, 'results', _done));
end $heal$;

-- ── the mirror trigger, last (its lock on profiles is held until commit) + a second backfill pass ──
drop trigger if exists trg_profiles_scg_mirror on public.profiles;
create trigger trg_profiles_scg_mirror after insert or update of group_id on public.profiles
  for each row execute function public.scg_mirror_main_group();

-- stale main rows first (a main that moved course in between), so the upsert can never leave two main rows
delete from public.student_course_groups s
 where s.is_main and not exists (select 1 from public.profiles p where p.id = s.user_id and p.group_id = s.group_id);
insert into public.student_course_groups (user_id, course_id, group_id, is_main, source)
select p.id, g.course_id, p.group_id, true, 'main'
  from public.profiles p join public.groups g on g.id = p.group_id
 where g.course_id is not null
on conflict (user_id, course_id) do update
  set group_id = excluded.group_id, is_main = true, source = 'main', updated_at = now();

-- ── self-test (read-only): the mirror is complete ──
do $test$
declare _h jsonb := public.student_course_groups_health();
begin
  if (_h->>'main_missing')::int <> 0 or (_h->>'main_stale')::int <> 0 or (_h->>'course_stale')::int <> 0
     or (_h->>'secondary_unenrolled')::int <> 0 then
    raise exception 'student_course_groups self-test failed: %', _h;
  end if;
end $test$;
