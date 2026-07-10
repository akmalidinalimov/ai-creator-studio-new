-- Comprehensive XP self-healing safety net (2026-07-10).
-- The daily_active gap (fixed in 20260710090000) proved a class of risk: XP is awarded by triggers
-- on the source tables, but any award a trigger MISSES (a bulk/replica-mode import that bypasses
-- triggers, a temporarily disabled trigger, an UPDATE where an INSERT was expected, a pre-trigger
-- backfill gap) is lost forever unless reconciled. Triggers stay the primary path (instant award);
-- this adds a periodic reconciler that re-derives every student XP source from its source-of-truth
-- table and awards anything missing — idempotent, so it only ever fills real gaps.
--
-- Sources reconciled (must mirror the trigger amounts + ref_keys exactly):
--   lesson_complete      +20  ref lesson:<lesson_id>       from lesson_progress.completed_at
--   homework_submit      +15  ref hw_submit:<assignment>   from homework_submissions
--   homework_high_score  +25  ref hw_score:<assignment>    from homework_submissions (score>=9)
--   daily_active         +5   ref day:<watch_date>         from daily_watch_summary
-- (Streak milestones are point-in-time on the streaks table and not reconstructable from history,
--  so they stay trigger-only — small +50/+200, low risk.)

create or replace function public.reconcile_all_xp()
returns table(source text, awarded int)
language plpgsql
security definer
set search_path = public
as $$
declare
  _lc int := 0; _hs int := 0; _hh int := 0; _da int := 0;
begin
  insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  select lp.user_id, 20, 'lesson_complete', 'lesson:' || lp.lesson_id::text, coalesce(lp.completed_at, now())
  from public.lesson_progress lp join auth.users u on u.id = lp.user_id
  where lp.completed_at is not null
  on conflict (user_id, ref_key) do nothing;
  get diagnostics _lc = row_count;

  insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  select hs.user_id, 15, 'homework_submit', 'hw_submit:' || hs.assignment_id::text, coalesce(hs.submitted_at, now())
  from public.homework_submissions hs join auth.users u on u.id = hs.user_id
  on conflict (user_id, ref_key) do nothing;
  get diagnostics _hs = row_count;

  insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  select hs.user_id, 25, 'homework_high_score', 'hw_score:' || hs.assignment_id::text, coalesce(hs.scored_at, hs.submitted_at, now())
  from public.homework_submissions hs join auth.users u on u.id = hs.user_id
  where hs.score is not null and hs.score >= 9
  on conflict (user_id, ref_key) do nothing;
  get diagnostics _hh = row_count;

  insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  select d.user_id, 5, 'daily_active', 'day:' || d.watch_date::text,
         coalesce(d.updated_at, (d.watch_date + time '12:00') at time zone 'UTC')
  from public.daily_watch_summary d join auth.users u on u.id = d.user_id
  on conflict (user_id, ref_key) do nothing;
  get diagnostics _da = row_count;

  -- Only rebuild totals when something was actually filled (normally 0 → no-op).
  if (_lc + _hs + _hh + _da) > 0 then
    insert into public.user_xp (user_id, total_xp, level, updated_at)
    select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
    from public.xp_events e
    group by e.user_id
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
  end if;

  return query values
    ('lesson_complete', _lc), ('homework_submit', _hs),
    ('homework_high_score', _hh), ('daily_active', _da);
end;
$$;
revoke execute on function public.reconcile_all_xp() from public, anon, authenticated;

-- Supersede the daily_active-only job with the comprehensive one; run hourly.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-daily-active-xp') then
    perform cron.unschedule('reconcile-daily-active-xp');
  end if;
  if exists (select 1 from cron.job where jobname = 'reconcile-all-xp') then
    perform cron.unschedule('reconcile-all-xp');
  end if;
  perform cron.schedule('reconcile-all-xp', '27 * * * *', $cmd$ select public.reconcile_all_xp() $cmd$);
end $$;
