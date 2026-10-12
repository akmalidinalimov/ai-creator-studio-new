-- The student groups get a morning greeting and a 21:00 thank-you, each an IMAGE with the text as its caption, in the
-- group's NETWORKING topic (owner, 2026-10-12: "every day a welcome message to every group, encouraging them to take
-- actions — share their work on Instagram, help each other, ask questions, generate images and videos, try something
-- practical … at 9 at night thank them for the day … with an image, the caption below it"). 6.0 groups only.
--
-- The group-room edge function (a sibling of teacher-room, 20261011063000) writes and sends the posts:
--   09:00 Tashkent  morning — a rotating greeting + three of the day's suggested actions + a closing line.
--   21:00 Tashkent  evening — a thank-you + the GROUP'S real day: lessons finished, homework submitted, curator answers,
--                   how many were active, and up to three of the day's most active students (never someone who hid
--                   themselves from the group boards). A quiet day gets an encouraging text, never "spectacular".
-- Images: public/group-room/{morning,evening}-{0..6}.jpg (scripts/render-group-room-images.py), one per weekday.
-- Topic: groups.networking_thread_id (new; filled below from the topics the bot has seen — 1-GURUH 4, 2-GURUH 8,
-- 3-GURUH 4, 4-GURUH 9). A group without one (5-GURUH, 6-GURUH today) is skipped and that is recorded, never guessed.
--
-- Each post is CLAIMED once per group per day (group_room_posts); the cron fires at :00 and :20, so a failed send is
-- retried once and a sent one is never repeated. If Telegram refuses the photo, the same text goes as a plain message
-- (as_text, logged). group_room_watchdog() (hourly :43) DMs the admins when a group's post is still missing 30 minutes
-- after its time. Kill-switch: platform_settings.group_room.enabled.

alter table public.groups add column if not exists networking_thread_id integer;

update public.groups g set networking_thread_id = v.thread
  from (values (-1004440955972::bigint, 4), (-1004390902020::bigint, 8), (-1003714608284::bigint, 4),
               (-1004463424516::bigint, 9)) v(chat, thread)
 where g.daily_task_chat_id = v.chat and g.networking_thread_id is null;

insert into public.platform_settings (key, value, updated_at)
values ('group_room', jsonb_build_object(
  'enabled', true,
  'course_ids', jsonb_build_array('f502f631-2104-4834-b6c2-702cd3080e27'),
  'morning_hour', 9, 'evening_hour', 21,
  'image_base', 'https://www.aicreator.academy/group-room',
  'quiet_active_below', 3), now())
on conflict (key) do nothing;

create table if not exists public.group_room_posts (
  day         date not null,
  kind        text not null check (kind in ('morning', 'evening')),
  group_id    uuid not null references public.groups(id) on delete cascade,
  claimed_at  timestamptz not null default now(),
  attempts    int not null default 1,
  message_id  bigint,
  sent_at     timestamptz,
  as_text     boolean not null default false,
  error       text,
  primary key (day, kind, group_id)
);
alter table public.group_room_posts enable row level security;   -- service role only
revoke all on public.group_room_posts from anon, authenticated;

-- Claim today's post for one group: a fresh claim, or a retry of an unsent one (no sent_at) claimed > 10 minutes ago.
create or replace function public.group_room_claim(_day date, _kind text, _group uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  with c as (
    insert into public.group_room_posts (day, kind, group_id) values (_day, _kind, _group)
    on conflict (day, kind, group_id) do update
      set attempts = group_room_posts.attempts + 1, claimed_at = now(), error = null
      where group_room_posts.sent_at is null and group_room_posts.message_id is null
        and group_room_posts.claimed_at < now() - interval '10 minutes'
    returning 1)
  select exists (select 1 from c);
$function$;

-- The groups of the configured courses, with their chat, NETWORKING topic and active student count; `ready` = can post.
create or replace function public.group_room_targets()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cfg as (select coalesce(value -> 'course_ids', '[]'::jsonb) c from public.platform_settings where key = 'group_room')
  select coalesce(jsonb_agg(jsonb_build_object(
           'group_id', g.id, 'group_name', g.name, 'chat_id', g.daily_task_chat_id,
           'thread_id', g.networking_thread_id,
           'students', (select count(*) from public.profiles p
                         where p.group_id = g.id and p.status = 'active' and p.archived_at is null),
           'ready', g.daily_task_chat_id is not null and g.networking_thread_id is not null)
         order by g.name), '[]'::jsonb)
    from public.groups g, cfg
   where g.course_id::text in (select jsonb_array_elements_text(cfg.c));
$function$;

-- One group's day [_from, _to): lessons finished for the first time (the +20 ledger, so a re-watch is not counted
-- twice), homework submitted, curator answers, active students, and up to three of the most active (boards opt-out
-- respected; staff never listed).
create or replace function public.group_room_stats(_group uuid, _from timestamptz, _to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with stu as (
    select p.id, p.name, p.last_name, p.telegram_username, coalesce(p.hide_from_group_boards, false) hidden
      from public.profiles p
     where p.group_id = _group and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('teacher', 'admin', 'superadmin'))),
  les as (select x.user_id, count(*) n from public.xp_events x join stu on stu.id = x.user_id
           where x.reason = 'lesson_complete' and x.created_at >= _from and x.created_at < _to group by 1),
  hw as (select h.user_id, count(*) n from public.homework_submissions h join stu on stu.id = h.user_id
          where h.submitted_at >= _from and h.submitted_at < _to group by 1),
  msg as (select distinct e.profile_id user_id from public.group_message_events e join stu on stu.id = e.profile_id
           where e.group_id = _group and e.created_at >= _from and e.created_at < _to),
  act as (
    select s.id, s.name, s.last_name, s.telegram_username, s.hidden,
           coalesce(les.n, 0) lessons, coalesce(hw.n, 0) homework
      from stu s left join les on les.user_id = s.id left join hw on hw.user_id = s.id
     where les.n is not null or hw.n is not null or s.id in (select user_id from msg))
  select jsonb_build_object(
    'students', (select count(*) from stu),
    'lessons', coalesce((select sum(n) from les), 0),
    'homework', coalesce((select sum(n) from hw), 0),
    'answered', (select count(*) from public.teacher_questions q
                  where q.group_id = _group and q.status = 'answered' and q.answered_at >= _from and q.answered_at < _to),
    'active', (select count(*) from act),
    'stars', coalesce((select jsonb_agg(jsonb_build_object('name', a.name, 'last_name', a.last_name,
                                                           'username', a.telegram_username, 'score', a.score))
                         from (select *, homework * 2 + lessons as score from act
                                where not hidden and homework * 2 + lessons > 0
                                order by homework * 2 + lessons desc, id limit 3) a), '[]'::jsonb));
$function$;

revoke execute on function public.group_room_claim(date, text, uuid) from public, anon, authenticated;
revoke execute on function public.group_room_targets() from public, anon, authenticated;
revoke execute on function public.group_room_stats(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.group_room_claim(date, text, uuid) to service_role;
grant execute on function public.group_room_targets() to service_role;
grant execute on function public.group_room_stats(uuid, timestamptz, timestamptz) to service_role;

-- A ready group whose post is still missing 30 minutes after its hour → the admins hear about it (once per day+set);
-- the hourly :43 run then catches a missing evening post at 21:43, before quiet hours.
create or replace function public.group_room_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'group_room'), '{}'::jsonb);
  _enabled boolean := coalesce(lower(_cfg->>'enabled'), 'true') <> 'false';
  _local timestamp := now() at time zone 'Asia/Tashkent';
  _today date := _local::date;
  _prev jsonb := (select value from public.app_settings where key = 'group_room_watchdog_state');
  _missing text[] := '{}';
  _k text; _hour int; _g record; _row record; _msg text; _tok text; _admin record; _alerted int := 0;
begin
  if _enabled then
    foreach _k in array array['morning', 'evening'] loop
      begin
        _hour := coalesce((_cfg->>(_k || '_hour'))::int, case when _k = 'morning' then 9 else 21 end);
      exception when others then _hour := case when _k = 'morning' then 9 else 21 end;
      end;
      if _local >= _today + make_interval(hours => _hour, mins => 30) then
        for _g in
          select (t->>'group_id')::uuid gid, t->>'group_name' gname
            from jsonb_array_elements(public.group_room_targets()) t
           where (t->>'ready')::boolean and (t->>'students')::int > 0
        loop
          select * into _row from public.group_room_posts where day = _today and kind = _k and group_id = _g.gid;
          if _row is null or _row.message_id is null then
            _missing := array_append(_missing, _k || ' · ' || _g.gname || coalesce(' (' || left(_row.error, 100) || ')', ''));
          end if;
        end loop;
      end if;
    end loop;
  end if;

  if cardinality(_missing) > 0 and coalesce(_prev->>'alerted_for', '') <> (_today::text || ':' || array_to_string(_missing, ',')) then
    _msg := '⚠️ Guruhlarga bugungi tong/kech xabari yuborilmadi:' || E'\n• ' || array_to_string(_missing, E'\n• ')
            || E'\n\nTekshirish: group_room_posts, admin_actions (group_room_*).';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active'
         order by p.telegram_id
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'group_room_watchdog',
            p_timeout_ms := 5000);
          _alerted := _alerted + 1;
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('group_room_watchdog_state', jsonb_build_object(
    'checked_at', now(), 'enabled', _enabled, 'missing', to_jsonb(_missing),
    'alerted_for', case when _alerted > 0 then to_jsonb(_today::text || ':' || array_to_string(_missing, ','))
                        else coalesce(_prev->'alerted_for', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('missing', to_jsonb(_missing), 'alerted', _alerted > 0);
end
$function$;

revoke execute on function public.group_room_watchdog() from public, anon, authenticated;
grant execute on function public.group_room_watchdog() to service_role;

-- 04:00 / 04:20 UTC = 09:00 / 09:20 Tashkent (morning); 16:00 / 16:20 UTC = 21:00 / 21:20 Tashkent (evening).
do $$
begin
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('group-room-morning', 'group-room-evening', 'group-room-watchdog');
  perform cron.schedule('group-room-morning', '0,20 4 * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/group-room', '{"kind":"morning"}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'group-room', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'group_room'), 'true') <> 'false' $cmd$);
  perform cron.schedule('group-room-evening', '0,20 16 * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/group-room', '{"kind":"evening"}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'group-room', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'group_room'), 'true') <> 'false' $cmd$);
  perform cron.schedule('group-room-watchdog', '43 * * * *', $cmd$ select public.group_room_watchdog() $cmd$);
end $$;

-- self-test (read-only): the stats run; fewer than four ready groups is a warning
do $test$
declare _t jsonb := public.group_room_targets(); _ready int; _s jsonb;
begin
  select count(*) into _ready from jsonb_array_elements(_t) x where (x->>'ready')::boolean;
  -- a group without a topic is only skipped (and recorded by the edge function), so this warns, never aborts
  if _ready < 4 then raise warning 'group_room: only % group(s) have a NETWORKING topic — expected 4', _ready; end if;
  _s := public.group_room_stats(((_t->0)->>'group_id')::uuid, now() - interval '1 day', now());
  if jsonb_typeof(_s) <> 'object' then raise exception 'selftest: group_room_stats is not an object'; end if;
  raise notice 'group_room: % ready of % — %', _ready, jsonb_array_length(_t), left(_s::text, 300);
end
$test$;
