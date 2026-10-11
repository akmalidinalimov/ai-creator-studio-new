-- «KURATORLAR 6.0» — the bot keeps the curators' group warm (owner, 2026-10-11: "every morning at 9 a warm message in
-- casual Uzbek … at the end of the day a thank-you with the statistics — how many homeworks, how many questions each
-- teacher answered … I don't have time every morning and evening; it must not sound robotic but encourage them").
--
-- The teacher-room edge function writes and sends the two posts (hand-written Uzbek text pools that rotate, so two
-- days in a row never read the same, around the day's REAL numbers):
--   09:00 Tashkent  morning — a greeting + yesterday's team result + today's queue (ungraded homework, waiting
--                   questions, the longest wait).
--   21:00 Tashkent  evening — a thank-you + per curator: homework graded, questions answered, median answer time,
--                   what is left for tomorrow + 🏆 the day's star and ⚡ the fastest answers (never naming a zero).
-- Stats: teacher_room_stats(_from, _to) — per group of the configured course(s) with a teacher, from
-- homework_submissions and teacher_questions (20261010051000; curators answering anonymously as their group are
-- credited to that group's curator).
--
-- Each post is CLAIMED once per day (teacher_room_posts, primary key (day, kind)); the cron fires at :00 and again at
-- :20, so a failed send is retried once and a sent one is never repeated. teacher_room_watchdog() (hourly :41) DMs the
-- admins when a post is missing 45 minutes after its time, and stamps teacher_room_watchdog_state.
-- Kill-switch: platform_settings.teacher_room.enabled. Chat: platform_settings.teacher_room.chat_id (KURATORLAR 6.0).

insert into public.platform_settings (key, value, updated_at)
values ('teacher_room', jsonb_build_object(
  'enabled', true, 'chat_id', -1004449580466, 'thread_id', null,
  'course_ids', jsonb_build_array('f502f631-2104-4834-b6c2-702cd3080e27'),
  'morning_hour', 9, 'evening_hour', 21), now())
on conflict (key) do nothing;

create table if not exists public.teacher_room_posts (
  day         date not null,
  kind        text not null check (kind in ('morning', 'evening')),
  claimed_at  timestamptz not null default now(),
  attempts    int not null default 1,
  message_id  bigint,
  sent_at     timestamptz,
  error       text,
  primary key (day, kind)
);
alter table public.teacher_room_posts enable row level security;   -- service role only
revoke all on public.teacher_room_posts from anon, authenticated;

-- Claim today's post: a fresh claim, or a retry of an unsent one claimed > 10 minutes ago. Never a second send.
create or replace function public.teacher_room_claim(_day date, _kind text)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  with c as (
    insert into public.teacher_room_posts (day, kind) values (_day, _kind)
    on conflict (day, kind) do update
      set attempts = teacher_room_posts.attempts + 1, claimed_at = now(), error = null
      where teacher_room_posts.message_id is null and teacher_room_posts.claimed_at < now() - interval '10 minutes'
    returning 1)
  select exists (select 1 from c);
$function$;

-- The day's numbers per group (and its curators) of the configured courses.
create or replace function public.teacher_room_stats(_from timestamptz, _to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cfg as (select coalesce(value -> 'course_ids', '[]'::jsonb) c from public.platform_settings where key = 'teacher_room'),
  g as (
    select g.id, g.name from public.groups g, cfg
     where g.course_id::text in (select jsonb_array_elements_text(cfg.c))
       and (g.teacher_id is not null or exists (select 1 from public.group_teachers gt where gt.group_id = g.id))),
  t as (
    select g.id gid, p.id, p.name, p.last_name, p.telegram_username
      from g join public.profiles p
        on p.id = (select teacher_id from public.groups where id = g.id)
        or p.id in (select gt.teacher_id from public.group_teachers gt where gt.group_id = g.id)),
  stu as (select p.id, p.group_id from public.profiles p join g on g.id = p.group_id),
  hw as (
    select s.group_id gid,
           count(*) filter (where h.scored_at >= _from and h.scored_at < _to and h.score is not null) graded,
           count(*) filter (where h.submitted_at >= _from and h.submitted_at < _to) submitted,
           count(*) filter (where h.score is null or h.score_is_stale) pending
      from public.homework_submissions h join stu s on s.id = h.user_id
     group by s.group_id),
  q as (
    select q.group_id gid,
           count(*) filter (where q.asked_at >= _from and q.asked_at < _to) asked,
           count(*) filter (where q.answered_at >= _from and q.answered_at < _to and q.status = 'answered') answered,
           count(*) filter (where q.status = 'open') open,
           max(extract(epoch from (now() - q.asked_at)) / 60) filter (where q.status = 'open') oldest_min,
           percentile_cont(0.5) within group (order by extract(epoch from (q.answered_at - q.asked_at)) / 60)
             filter (where q.answered_at >= _from and q.answered_at < _to and q.status = 'answered') median_min
      from public.teacher_questions q join g on g.id = q.group_id
     group by q.group_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'group_id', g.id, 'group_name', g.name,
           'teachers', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'last_name', t.last_name,
                                                                    'username', t.telegram_username)), '[]'::jsonb)
                          from t where t.gid = g.id),
           'graded', coalesce(hw.graded, 0), 'submitted', coalesce(hw.submitted, 0), 'pending', coalesce(hw.pending, 0),
           'asked', coalesce(q.asked, 0), 'answered', coalesce(q.answered, 0), 'open', coalesce(q.open, 0),
           'oldest_min', round(coalesce(q.oldest_min, 0)), 'median_min', round(q.median_min::numeric, 1))
         order by g.name), '[]'::jsonb)
    from g left join hw on hw.gid = g.id left join q on q.gid = g.id;
$function$;

revoke execute on function public.teacher_room_claim(date, text) from public, anon, authenticated;
revoke execute on function public.teacher_room_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.teacher_room_claim(date, text) to service_role;
grant execute on function public.teacher_room_stats(timestamptz, timestamptz) to service_role;

-- A post still missing 45 minutes after its hour → the admins hear about it (once per post).
create or replace function public.teacher_room_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'teacher_room'), '{}'::jsonb);
  _enabled boolean := coalesce(lower(_cfg->>'enabled'), 'true') <> 'false';
  _local timestamp := now() at time zone 'Asia/Tashkent';
  _today date := _local::date;
  _prev jsonb := (select value from public.app_settings where key = 'teacher_room_watchdog_state');
  _missing text[] := '{}';
  _k text; _hour int; _row record; _msg text; _tok text; _admin record; _alerted text[] := '{}';
begin
  if _enabled then
    foreach _k in array array['morning', 'evening'] loop
      begin
        _hour := coalesce((_cfg->>(_k || '_hour'))::int, case when _k = 'morning' then 9 else 21 end);
      exception when others then _hour := case when _k = 'morning' then 9 else 21 end;
      end;
      if _local >= _today + make_interval(hours => _hour, mins => 45) then
        select * into _row from public.teacher_room_posts where day = _today and kind = _k;
        if _row is null or _row.message_id is null then
          _missing := array_append(_missing, _k || coalesce(' (' || left(_row.error, 120) || ')', ''));
        end if;
      end if;
    end loop;
  end if;

  if cardinality(_missing) > 0 and coalesce(_prev->>'alerted_for', '') <> (_today::text || ':' || array_to_string(_missing, ',')) then
    _msg := '⚠️ KURATORLAR guruhiga bugungi xabar(lar) yuborilmadi: ' || array_to_string(_missing, '; ')
            || E'\n\nTekshirish: teacher_room_posts, admin_actions (teacher_room_*).';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active' limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'teacher_room_watchdog',
            p_timeout_ms := 5000);
          _alerted := array_append(_alerted, _admin.telegram_id::text);
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('teacher_room_watchdog_state', jsonb_build_object(
    'checked_at', now(), 'enabled', _enabled, 'missing', to_jsonb(_missing),
    'alerted_for', case when cardinality(_alerted) > 0 then to_jsonb(_today::text || ':' || array_to_string(_missing, ','))
                        else coalesce(_prev->'alerted_for', 'null'::jsonb) end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('missing', to_jsonb(_missing), 'alerted', cardinality(_alerted) > 0);
end
$function$;

revoke execute on function public.teacher_room_watchdog() from public, anon, authenticated;
grant execute on function public.teacher_room_watchdog() to service_role;

-- 04:00 / 04:20 UTC = 09:00 / 09:20 Tashkent (morning); 16:00 / 16:20 UTC = 21:00 / 21:20 Tashkent (evening).
do $$
begin
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('teacher-room-morning', 'teacher-room-evening', 'teacher-room-watchdog');
  perform cron.schedule('teacher-room-morning', '0,20 4 * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/teacher-room', '{"kind":"morning"}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'teacher-room', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'teacher_room'), 'true') <> 'false' $cmd$);
  perform cron.schedule('teacher-room-evening', '0,20 16 * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/teacher-room', '{"kind":"evening"}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'teacher-room', 60000)
   where coalesce((select lower(value->>'enabled') from public.platform_settings where key = 'teacher_room'), 'true') <> 'false' $cmd$);
  perform cron.schedule('teacher-room-watchdog', '41 * * * *', $cmd$ select public.teacher_room_watchdog() $cmd$);
end $$;

-- self-test (read-only): the stats run and see the four Challenge groups with their curators
do $test$
declare _s jsonb := public.teacher_room_stats(now() - interval '1 day', now());
begin
  if jsonb_typeof(_s) <> 'array' then raise exception 'selftest: teacher_room_stats is not an array'; end if;
  raise notice 'teacher_room_stats: % groups — %', jsonb_array_length(_s), left(_s::text, 400);
end
$test$;
