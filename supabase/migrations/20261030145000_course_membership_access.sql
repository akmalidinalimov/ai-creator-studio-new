-- Course membership access (owner, 2026-10-30, Challenge 7.0): "When students join the Telegram channel where we have
-- our lessons, they should also be able to see the content in the platform. If they are not a member of one of the
-- groups or the channel, then they shouldn't be able to see the content." Grace before the lock: 24 h (owner: "OK").
--
-- Opt-in PER COURSE (courses.membership_required) — 6.0 and every other course are untouched.
--
--   courses.telegram_channel_chat_id / telegram_channel_url   the course's lessons channel (the bot must be its admin)
--   courses.channel_group_id                                  where a channel-only member is registered (a holding group
--                                                             with the course tier; moving to a real group is normal)
--   course_memberships                                        per (student, course): member / not since when / checked
--   course_membership_chats(course)                           the channel + every group chat of the course
--   course_membership_ready(course)                           the channel AND every group (but the holding group) has a
--                                                             known chat id — until then nobody is recorded as gone
--   course_membership_due(limit)                              who the checker (edge fn course-membership-check) probes:
--                                                             flagged by a leave event, never checked, or > 20 h old
--   course_membership_record(...)                             the ONLY writer of the state (member / not / unknown)
--   course_membership_place(uid, course, chat)                a channel-only student (holding group) seen in a REAL
--                                                             group chat of the course moves into that group
--   course_membership_request_check(uid, course)              re-probe soon (a locked student opening a lesson)
--   course_membership_locked(uid, course)                     TRUE only when: kill-switch on, course requires membership,
--                                                             and the student was seen NOT a member > grace_hours ago
--   has_module_access                                         + that lock, right after the enrollment check (staff are
--                                                             let through before it, as before). Every content path
--                                                             reads it: lesson-video-url, video progress, homework
--                                                             submit, study assistant.
--
-- Fail-open by construction: no row / an unknown answer (Telegram error) / a course whose chats are not all known yet
-- never locks; only two clean "not a member"
-- answers 24 h apart (first sighting starts the clock) do. Rejoining unlocks at the next check, at once via the bot.
-- Kill-switch: platform_settings.course_membership.enabled = false (nobody is locked; state keeps being recorded).
-- Health: the checker writes course_membership_check every run; course_membership_watchdog (:52) DMs the admins when a
-- membership course has had no completed check for 3 h.

-- ── schema ──
alter table public.courses
  add column if not exists telegram_channel_chat_id bigint,
  add column if not exists telegram_channel_url text,
  add column if not exists membership_required boolean not null default false,
  add column if not exists channel_group_id uuid references public.groups(id) on delete set null;

create table if not exists public.course_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  member boolean,                      -- null = not determined yet
  member_seen_at timestamptz,
  not_member_since timestamptz,        -- first clean "not a member" of the current absence; null while a member
  checked_at timestamptz,
  needs_check boolean not null default true,
  last_error text,
  warned_at timestamptz,               -- the "rejoin within 24 h" DM of the current absence
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);
create index if not exists course_memberships_due_idx on public.course_memberships (needs_check, checked_at);
alter table public.course_memberships enable row level security;
revoke all on table public.course_memberships from public, anon, authenticated;
grant all on table public.course_memberships to service_role;

insert into public.platform_settings (key, value)
values ('course_membership', jsonb_build_object('enabled', true, 'grace_hours', 24, 'recheck_hours', 20, 'batch', 300))
on conflict (key) do nothing;

-- ── functions ──
create or replace function public.course_membership_cfg()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select coalesce((select value from public.platform_settings where key = 'course_membership'), '{}'::jsonb);
$function$;

create or replace function public.course_membership_locked(_uid uuid, _course uuid)
returns boolean language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $function$
declare _cfg jsonb := public.course_membership_cfg(); _grace int;
begin
  if coalesce(lower(_cfg->>'enabled'), 'false') <> 'true' then return false; end if;
  if not exists (select 1 from public.courses where id = _course and membership_required) then return false; end if;
  -- a course whose chats are not all known (e.g. a new group without its chat yet) locks nobody, old absences included
  if not coalesce((public.course_membership_ready(_course)->>'ready')::boolean, false) then return false; end if;
  begin _grace := greatest(coalesce((_cfg->>'grace_hours')::int, 24), 1); exception when others then _grace := 24; end;
  return exists (select 1 from public.course_memberships m
                  where m.user_id = _uid and m.course_id = _course and m.member = false
                    and m.not_member_since <= now() - make_interval(hours => _grace));
end
$function$;

-- the channel + each group chat of the course (the chat id lives in daily_task_chat_id, or in a /c/<id>/ link)
create or replace function public.course_membership_chats(_course uuid)
returns setof bigint language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select distinct x from (
    select c.telegram_channel_chat_id x from public.courses c where c.id = _course
    union all
    select g.daily_task_chat_id from public.groups g where g.course_id = _course
    union all
    select ('-100' || (regexp_match(u, '/c/(\d+)/'))[1])::bigint
      from public.groups g, unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
     where g.course_id = _course and u ~ '/c/\d+/'
    union all
    select ('-100' || (regexp_match(t.telegram_topic_url, '/c/(\d+)/'))[1])::bigint
      from public.group_module_topics t join public.groups g on g.id = t.group_id
     where g.course_id = _course and t.telegram_topic_url ~ '/c/\d+/'
  ) s where x is not null;
$function$;

-- every chat a member could be in must be known before an absence can be trusted: the channel, and each group (the
-- holding group has no chat of its own). A group whose topics are not configured yet would make its members look gone.
create or replace function public.course_membership_ready(_course uuid)
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select jsonb_build_object(
    'ready', c.telegram_channel_chat_id is not null and cardinality(m.missing) = 0,
    'channel', c.telegram_channel_chat_id is not null,
    'groups_missing_chat', to_jsonb(m.missing))
    from public.courses c,
         lateral (select coalesce(array_agg(g.name order by g.name), '{}') missing
                    from public.groups g
                   where g.course_id = c.id and g.id is distinct from c.channel_group_id
                     and g.daily_task_chat_id is null
                     and not exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                                      where u ~ '/c/\d+/')
                     and not exists (select 1 from public.group_module_topics t
                                      where t.group_id = g.id and t.telegram_topic_url ~ '/c/\d+/')) m
   where c.id = _course;
$function$;

-- who to probe now: students (not staff) enrolled in a published membership course, with a Telegram id
create or replace function public.course_membership_due(_limit int default 300)
returns table (user_id uuid, course_id uuid, telegram_id bigint, chats bigint[], member boolean, ready boolean,
               channel_chat_id bigint, in_holding boolean)
language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  -- the group chats first, the channel last: a holding-group student found in a real group is placed there
  select e.user_id, e.course_id, p.telegram_id,
         array(select x from public.course_membership_chats(e.course_id) x
                order by (x is not distinct from c.telegram_channel_chat_id), x), m.member,
         coalesce((public.course_membership_ready(e.course_id)->>'ready')::boolean, false),
         c.telegram_channel_chat_id, p.group_id is not distinct from c.channel_group_id
    from public.enrollments e
    join public.courses c on c.id = e.course_id and c.membership_required and c.published
    join public.profiles p on p.id = e.user_id and p.telegram_id is not null and coalesce(p.status, 'active') = 'active'
    left join public.course_memberships m on m.user_id = e.user_id and m.course_id = e.course_id
   where not exists (select 1 from public.user_roles r where r.user_id = e.user_id
                      and r.role in ('admin'::app_role, 'superadmin'::app_role, 'teacher'::app_role))
     and (m.user_id is null or m.needs_check or m.checked_at is null
          or m.checked_at < now() - make_interval(hours => greatest(coalesce((public.course_membership_cfg()->>'recheck_hours')::int, 20), 1)))
   order by m.needs_check desc nulls first, m.checked_at nulls first
   limit greatest(coalesce(_limit, 300), 1);
$function$;

-- the only writer. _member: true / false / null (= unknown: a Telegram error — never moves the state)
create or replace function public.course_membership_record(_uid uuid, _course uuid, _member boolean, _error text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _prev public.course_memberships; _now timestamptz := now();
begin
  select * into _prev from public.course_memberships where user_id = _uid and course_id = _course for update;
  if _member is null then
    insert into public.course_memberships as m (user_id, course_id, checked_at, needs_check, last_error, updated_at)
    values (_uid, _course, _now, false, left(_error, 300), _now)
    on conflict (user_id, course_id) do update
      set checked_at = _now, needs_check = false, last_error = left(_error, 300), updated_at = _now;
    return jsonb_build_object('state', 'unknown');
  elsif _member then
    insert into public.course_memberships as m (user_id, course_id, member, member_seen_at, not_member_since, checked_at,
                                                needs_check, last_error, warned_at, updated_at)
    values (_uid, _course, true, _now, null, _now, false, null, null, _now)
    on conflict (user_id, course_id) do update
      set member = true, member_seen_at = _now, not_member_since = null, checked_at = _now, needs_check = false,
          last_error = null, warned_at = null, updated_at = _now;
    return jsonb_build_object('state', 'member', 'rejoined', coalesce(_prev.member = false, false));
  else
    insert into public.course_memberships as m (user_id, course_id, member, not_member_since, checked_at, needs_check,
                                                last_error, updated_at)
    values (_uid, _course, false, _now, _now, false, null, _now)
    on conflict (user_id, course_id) do update
      set member = false, not_member_since = coalesce(case when m.member = false then m.not_member_since end, _now),
          checked_at = _now, needs_check = false, last_error = null, updated_at = _now;
    return jsonb_build_object('state', 'not_member', 'new_absence', coalesce(_prev.member is distinct from false, true),
                              'warned', _prev.warned_at is not null and _prev.member = false,
                              'locked', public.course_membership_locked(_uid, _course));
  end if;
end
$function$;

-- a leave event in one of the course chats: re-check that student soon (the checker probes the other chats too)
create or replace function public.course_membership_flag(_telegram_id bigint, _chat_id bigint)
returns int language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _n int := 0; _r record;
begin
  for _r in
    select e.user_id, e.course_id from public.enrollments e
      join public.courses c on c.id = e.course_id and c.membership_required
      join public.profiles p on p.id = e.user_id and p.telegram_id = _telegram_id
     where _chat_id in (select public.course_membership_chats(e.course_id))
  loop
    insert into public.course_memberships (user_id, course_id, needs_check, updated_at)
    values (_r.user_id, _r.course_id, true, now())
    on conflict (user_id, course_id) do update set needs_check = true, updated_at = now();
    _n := _n + 1;
  end loop;
  return _n;
end
$function$;

-- a member seen in a course chat (a join event, /start): member now — unlocks at once
create or replace function public.course_membership_seen(_telegram_id bigint, _chat_id bigint)
returns int language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _n int := 0; _r record;
begin
  for _r in
    select e.user_id, e.course_id from public.enrollments e
      join public.courses c on c.id = e.course_id and c.membership_required
      join public.profiles p on p.id = e.user_id and p.telegram_id = _telegram_id
     where _chat_id in (select public.course_membership_chats(e.course_id))
  loop
    perform public.course_membership_record(_r.user_id, _r.course_id, true);
    perform public.course_membership_place(_r.user_id, _r.course_id, _chat_id);
    _n := _n + 1;
  end loop;
  return _n;
end
$function$;

-- a student registered through the channel (holding group) who is seen in a REAL group chat of the course moves into
-- that group, so their homework there is theirs (not «another group's topic»). Same course: a plain group change; the
-- enrollment, points and grades stay (group-move carry). Anyone already in a real group is left where they are.
create or replace function public.course_membership_place(_uid uuid, _course uuid, _chat_id bigint)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare _hold uuid; _target uuid;
begin
  select channel_group_id into _hold from public.courses where id = _course;
  if _hold is null or not exists (select 1 from public.profiles where id = _uid and group_id = _hold) then return null; end if;
  select g.id into _target
    from public.groups g
   where g.course_id = _course and g.id <> _hold
     and (g.daily_task_chat_id = _chat_id
          or exists (select 1 from unnest(array[g.homework_topic_url, g.telegram_group_url, g.daily_task_topic_url]) u
                      where u ~ '/c/\d+/' and ('-100' || (regexp_match(u, '/c/(\d+)/'))[1])::bigint = _chat_id)
          or exists (select 1 from public.group_module_topics t
                      where t.group_id = g.id and t.telegram_topic_url ~ '/c/\d+/'
                        and ('-100' || (regexp_match(t.telegram_topic_url, '/c/(\d+)/'))[1])::bigint = _chat_id))
   order by g.created_at limit 1;
  if _target is null then return null; end if;
  update public.profiles set group_id = _target where id = _uid and group_id = _hold;
  if found then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'course_membership_placed', _uid, jsonb_build_object('course_id', _course, 'from_group', _hold,
            'to_group', _target, 'chat_id', _chat_id));
    return _target;
  end if;
  return null;
end
$function$;

create or replace function public.course_membership_request_check(_uid uuid, _course uuid)
returns void language sql security definer set search_path to 'public', 'pg_temp' as $function$
  update public.course_memberships set needs_check = true, updated_at = now()
   where user_id = _uid and course_id = _course and not needs_check;
$function$;

create or replace function public.course_membership_mark_warned(_uid uuid, _course uuid)
returns void language sql security definer set search_path to 'public', 'pg_temp' as $function$
  update public.course_memberships set warned_at = now() where user_id = _uid and course_id = _course and member = false;
$function$;

revoke execute on function public.course_membership_cfg() from public, anon, authenticated;
revoke execute on function public.course_membership_locked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.course_membership_chats(uuid) from public, anon, authenticated;
revoke execute on function public.course_membership_ready(uuid) from public, anon, authenticated;
revoke execute on function public.course_membership_due(int) from public, anon, authenticated;
revoke execute on function public.course_membership_record(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.course_membership_flag(bigint, bigint) from public, anon, authenticated;
revoke execute on function public.course_membership_seen(bigint, bigint) from public, anon, authenticated;
revoke execute on function public.course_membership_place(uuid, uuid, bigint) from public, anon, authenticated;
revoke execute on function public.course_membership_request_check(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.course_membership_mark_warned(uuid, uuid) from public, anon, authenticated;
grant execute on function public.course_membership_cfg() to service_role;
grant execute on function public.course_membership_locked(uuid, uuid) to service_role;
grant execute on function public.course_membership_chats(uuid) to service_role;
grant execute on function public.course_membership_ready(uuid) to service_role;
grant execute on function public.course_membership_due(int) to service_role;
grant execute on function public.course_membership_record(uuid, uuid, boolean, text) to service_role;
grant execute on function public.course_membership_flag(bigint, bigint) to service_role;
grant execute on function public.course_membership_seen(bigint, bigint) to service_role;
grant execute on function public.course_membership_place(uuid, uuid, bigint) to service_role;
grant execute on function public.course_membership_request_check(uuid, uuid) to service_role;
grant execute on function public.course_membership_mark_warned(uuid, uuid) to service_role;

-- ── has_module_access: + the membership lock (rewritten from the LIVE definition, pinned) ──
do $pin$
declare _def text := pg_get_functiondef('public.has_module_access(uuid,uuid)'::regprocedure);
begin
  -- a replay (the rewrite below is already live) passes; any OTHER change to the function refuses the file
  if position('course_membership_locked' in _def) = 0 and md5(_def) <> 'cd321b71d67ef19cdc4273f96b4d6520' then
    raise exception 'has_module_access changed since 2026-10-30 — re-derive this rewrite from the live definition';
  end if;
end $pin$;

CREATE OR REPLACE FUNCTION public.has_module_access(_user_id uuid, _module_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _course uuid;
  _limit int;
  _enrolled boolean := false;
  _rank int;
begin
  if public.has_role(_user_id,'admin'::app_role)
     or public.has_role(_user_id,'superadmin'::app_role)
     or public.has_role(_user_id,'teacher'::app_role) then
    return true;
  end if;

  select course_id into _course from public.modules where id = _module_id;
  if _course is null then return false; end if;

  -- Course must be active (published). Deactivating a course locks it for students.
  if not exists (select 1 from public.courses c where c.id = _course and c.published) then
    return false;
  end if;

  select true, ct.module_limit into _enrolled, _limit
  from public.enrollments e
  left join public.course_tiers ct on ct.id = e.tier_id
  where e.user_id = _user_id and e.course_id = _course
  limit 1;

  if not coalesce(_enrolled, false) then return false; end if;

  -- 20261030145000: a course that requires Telegram membership (courses.membership_required) is closed to a student
  -- who left its channel and every one of its groups more than grace_hours ago (course_membership_locked: fail-open).
  if public.course_membership_locked(_user_id, _course) then return false; end if;

  if _limit is null then return true; end if;

  -- an always-open module (e.g. a bonus) is open to every enrolled student, whatever the tier limit
  if exists (select 1 from public.modules where id = _module_id and always_open) then return true; end if;

  select rnk into _rank from (
    select id, row_number() over (order by position, created_at) as rnk
    from public.modules where course_id = _course
  ) r where r.id = _module_id;

  return coalesce(_rank, 999999) <= _limit;
end;
$function$;

-- the ACL stays exactly as it is live (service_role only; CREATE OR REPLACE keeps it — made explicit here)
revoke execute on function public.has_module_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.has_module_access(uuid, uuid) to service_role;

-- ── watchdog: a membership course whose checker has not completed a run for 3 h ──
create or replace function public.course_membership_watchdog()
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  _last timestamptz := (select max(created_at) from public.admin_actions where action = 'course_membership_check');
  _active boolean := exists (select 1 from public.courses where membership_required and published);
  _enabled boolean := coalesce(lower(public.course_membership_cfg()->>'enabled'), 'false') = 'true';
  _prev jsonb := (select value from public.app_settings where key = 'course_membership_watchdog_state');
  _stale boolean; _tok text; _admin record; _alerted int := 0; _key text;
begin
  _stale := _active and _enabled and (_last is null or _last < now() - interval '3 hours');
  _key := to_char(now() at time zone 'Asia/Tashkent', 'YYYY-MM-DD');
  if _stale and coalesce(_prev->>'alerted_for', '') <> _key then
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
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text',
                              '⚠️ Kanal/guruh a''zoligi tekshiruvi 3 soatdan beri ishlamadi (course-membership-check). '
                              || 'Hech kim bloklanmaydi, lekin chiqib ketganlar ham aniqlanmaydi. Oxirgi: '
                              || coalesce(to_char(_last at time zone 'Asia/Tashkent', 'DD.MM HH24:MI'), 'hech qachon')),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'course_membership_watchdog',
            p_timeout_ms := 5000);
          _alerted := _alerted + 1;
        exception when others then null; end;
      end loop;
    end if;
  end if;
  insert into public.app_settings (key, value)
  values ('course_membership_watchdog_state', jsonb_build_object('checked_at', now(), 'stale', _stale, 'last_run', _last,
          'alerted_for', case when _alerted > 0 then to_jsonb(_key) else coalesce(_prev->'alerted_for', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('stale', _stale, 'alerted', _alerted > 0);
end
$function$;
revoke execute on function public.course_membership_watchdog() from public, anon, authenticated;
grant execute on function public.course_membership_watchdog() to service_role;

-- ── schedule: the checker every 15 min (works only while a membership course is published), the watchdog hourly ──
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('course-membership-check', 'course-membership-watchdog');
  perform cron.schedule('course-membership-check', '*/15 * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/course-membership-check', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'course-membership-check', 60000)
   where exists (select 1 from public.courses where membership_required and published) $cmd$);
  perform cron.schedule('course-membership-watchdog', '52 * * * *', $cmd$ select public.course_membership_watchdog() $cmd$);
end $$;

-- ── 7.0: requires membership; channel-only members land in a holding group with the course tier ──
do $$
declare
  _c constant uuid := 'a13b606e-11d3-47e5-a2ff-6815790f7311';
  _tier uuid;
  _hold uuid;
begin
  select id into _tier from public.course_tiers where course_id = _c order by position limit 1;
  if _tier is null then
    raise notice '7.0 has no tier yet (20261030142800 not applied?) — membership left off';
    return;
  end if;
  select id into _hold from public.groups where course_id = _c and name = 'AC CHALLENGE 7.0 | KANAL';
  if _hold is null then
    insert into public.groups (name, course_id, tier_id) values ('AC CHALLENGE 7.0 | KANAL', _c, _tier) returning id into _hold;
  end if;
  update public.courses
     set membership_required = true,
         telegram_channel_url = coalesce(telegram_channel_url, 'https://t.me/+srXusW0zCM41NDg0'),
         channel_group_id = coalesce(channel_group_id, _hold)
   where id = _c;
end $$;

-- ── self-test (read-only, pure): the lock is false for a course that does not require membership ──
do $test$
declare _n int;
begin
  if public.course_membership_locked(gen_random_uuid(), 'f502f631-2104-4834-b6c2-702cd3080e27') then
    raise exception 'self-test: 6.0 must never be membership-locked';
  end if;
  if public.course_membership_locked(gen_random_uuid(), 'a13b606e-11d3-47e5-a2ff-6815790f7311') then
    raise exception 'self-test: a student with no membership row must never be locked';
  end if;
  -- read-only runs of every set-returning helper (they are SQL bodies: only a call proves they plan)
  select count(*) into _n from public.course_membership_due(5);
  select count(*) into _n from public.course_membership_chats('a13b606e-11d3-47e5-a2ff-6815790f7311');
  perform public.course_membership_ready('a13b606e-11d3-47e5-a2ff-6815790f7311');
end $test$;
