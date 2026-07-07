-- Badge DMs go out in real time (within ~1 min of earning), NOT batched at 21:00.
-- A single student earning several badges in one session gets them spaced ~5 min
-- apart so each arrives as its own postable moment instead of a clump. Overnight
-- badges (22:00-08:00 Tashkent) hold until 08:00 so nobody gets a 3 AM ping.
-- (Supersedes the 21:00 batch from 20260707140000; keeps the earned_at fix.)

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
begin
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
