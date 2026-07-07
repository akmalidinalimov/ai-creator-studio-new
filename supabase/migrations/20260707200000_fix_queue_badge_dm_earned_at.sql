-- Fix: 20260707140000 (9pm window) reintroduced a reference to NEW.awarded_at in
-- queue_badge_dm(), but user_badges has NO awarded_at column (it's earned_at).
-- Result: every NEW badge award (first_homework, first_lesson, streaks, …) threw
-- "record new has no field awarded_at", rolling back the triggering op — including
-- first-time homework submissions. Restore earned_at; keep the 21:00 window.

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
  if now() < today_9pm then
    sched := today_9pm;
  else
    sched := ((((now() at time zone tz)::date) + 1) + time '21:00') at time zone tz;
  end if;

  insert into public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  values (new.user_id, new.badge_id, coalesce(new.earned_at, now()), sched);
  return new;
end;
$$;
