-- Per-course badge switch. A finished course (AI CREATORS 4.0) should stop
-- generating badge DMs, while active + future courses keep working with zero
-- config. queue_badge_dm now skips any student whose course has
-- badges_enabled = false. Students with no course (ungrouped) are treated as
-- enabled (null <> false), preserving current behaviour.

alter table public.courses
  add column if not exists badges_enabled boolean not null default true;

update public.courses set badges_enabled = false where title = 'AI CREATORS 4.0';

create or replace function public.queue_badge_dm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tz           constant text := 'Asia/Tashkent';
  tk_hour      int  := extract(hour from now() at time zone tz)::int;
  tk_today     date := (now() at time zone tz)::date;
  base         timestamptz;
  last_pending timestamptz;
  sched        timestamptz;
  v_enabled    boolean;
begin
  -- Skip badges for finished/disabled courses (e.g. AI CREATORS 4.0).
  select c.badges_enabled into v_enabled
  from public.profiles p
  join public.groups g on g.id = p.group_id
  join public.courses c on c.id = g.course_id
  where p.id = new.user_id;
  if v_enabled is false then
    return new;
  end if;

  -- Real time, but never during quiet hours (22:00–08:00 → next 08:00 Tashkent).
  if tk_hour >= 22 then
    base := ((tk_today + 1) + time '08:00') at time zone tz;
  elsif tk_hour < 8 then
    base := (tk_today + time '08:00') at time zone tz;
  else
    base := now();
  end if;

  -- Stagger: keep this student's still-unsent badges ≥ 5 min apart.
  select max(scheduled_for) into last_pending
  from public.badge_award_queue
  where user_id = new.user_id and sent_at is null;

  if last_pending is not null and last_pending + interval '5 minutes' > base then
    sched := last_pending + interval '5 minutes';
  else
    sched := base;
  end if;

  insert into public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  values (new.user_id, new.badge_id, coalesce(new.earned_at, now()), sched);
  return new;
end;
$$;
