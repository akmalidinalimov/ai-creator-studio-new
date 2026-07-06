-- Badge DMs go out in a single daily batch at 21:00 Asia/Tashkent — evening is
-- when students are idle and can actually post the card to their Instagram Story.
-- Award triggers still detect qualifiers in real time; we only change WHEN the
-- queued DM is delivered: every badge is scheduled for the next 21:00 Tashkent.
-- The existing pg_cron drain (every minute) flushes them once that time passes.

create or replace function public.queue_badge_dm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tz         constant text := 'Asia/Tashkent';
  today_9pm  timestamptz := (((now() at time zone tz)::date) + time '21:00') at time zone tz;
  sched      timestamptz;
begin
  -- next 21:00 Tashkent: today if we're still before it, else tomorrow
  if now() < today_9pm then
    sched := today_9pm;
  else
    sched := ((((now() at time zone tz)::date) + 1) + time '21:00') at time zone tz;
  end if;

  insert into public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  values (new.user_id, new.badge_id, coalesce(new.awarded_at, now()), sched);
  return new;
end;
$$;

-- Honor the "hold until evening" intent: move any already-queued, unsent badges
-- to the next 21:00 Tashkent so nothing goes out mid-day.
update public.badge_award_queue
set scheduled_for = case
  when now() < (((now() at time zone 'Asia/Tashkent')::date) + time '21:00') at time zone 'Asia/Tashkent'
    then (((now() at time zone 'Asia/Tashkent')::date) + time '21:00') at time zone 'Asia/Tashkent'
  else ((((now() at time zone 'Asia/Tashkent')::date) + 1) + time '21:00') at time zone 'Asia/Tashkent'
end
where sent_at is null;
