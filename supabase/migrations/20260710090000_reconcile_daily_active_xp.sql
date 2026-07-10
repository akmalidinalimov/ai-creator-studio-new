-- Reconcile daily-active XP (2026-07-10).
-- Students earn +5 'daily_active' XP per watch day (trigger xp_on_daily_activity on
-- daily_watch_summary INSERT). But the gamification migration (20260706090000) deliberately did
-- NOT reconstruct daily-activity history — so every watch day BEFORE the trigger went live got no
-- +5. Impact: 6,274 watch-days across 419 students under-credited (~31,370 XP). Students watched
-- heavily (hours/day) but saw their points stall. daily_watch_summary holds the full history, so
-- this is fully recoverable. Idempotent (ref_key `day:<date>` is unique per user+day).
-- lesson_complete / homework XP were already backfilled and have ZERO gaps — daily_active is the
-- only under-credited source.

-- (1) One-time backfill: +5 for every (user, watch_date) missing its daily_active event.
--     created_at = the watch row's own timestamp (truthful), fallback to noon of that day.
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select dws.user_id, 5, 'daily_active', 'day:' || dws.watch_date::text,
       coalesce(dws.updated_at, (dws.watch_date + time '12:00') at time zone 'UTC')
from public.daily_watch_summary dws
join auth.users u on u.id = dws.user_id
on conflict (user_id, ref_key) do nothing;

-- (2) Rebuild running totals + levels from the authoritative ledger (covers the new events).
insert into public.user_xp (user_id, total_xp, level, updated_at)
select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
from public.xp_events e
group by e.user_id
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

-- (3) Ongoing safety net: a daily job that awards any still-missing daily_active (idempotent).
--     Uses award_xp so user_xp stays in sync. After the backfill this should find ~0 rows/day
--     (the trigger handles new inserts) — it exists so a future trigger miss can never silently
--     cost students their points again.
create or replace function public.reconcile_daily_active_xp()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _n int := 0;
  _r record;
begin
  for _r in
    select dws.user_id, dws.watch_date
    from public.daily_watch_summary dws
    join auth.users u on u.id = dws.user_id
    where not exists (
      select 1 from public.xp_events e
      where e.user_id = dws.user_id and e.reason = 'daily_active'
        and e.ref_key = 'day:' || dws.watch_date::text)
  loop
    perform public.award_xp(_r.user_id, 5, 'daily_active', 'day:' || _r.watch_date::text);
    _n := _n + 1;
  end loop;
  return _n;
end;
$$;
revoke execute on function public.reconcile_daily_active_xp() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-daily-active-xp') then
    perform cron.unschedule('reconcile-daily-active-xp');
  end if;
  perform cron.schedule('reconcile-daily-active-xp', '17 1 * * *',
    $cmd$ select public.reconcile_daily_active_xp() $cmd$);
end $$;
