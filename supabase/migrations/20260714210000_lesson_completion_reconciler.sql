-- Lesson-completion safety-net reconciler (2026-07-14, owner request).
-- Completion is currently written client-side from the lesson page (5 paths). Those writes
-- are reliable, but a lost final tick (tab closed at 99%, network blip) could leave a lesson
-- watched-to-threshold with completed_at still NULL. This reconciler re-DERIVES completion from
-- the durable watch progress (max_position_seconds / duration_seconds_v2, which track_video_progress
-- always persists), matching the platform's "triggers are instant, reconcilers re-derive from
-- source-of-truth" architecture. Audit at build time: 0 such rows existed — this is pure insurance.
--
-- Threshold matches the live rule's completion check in track_video_progress: >=85% reached OR
-- within 20s of the end. (track_video_progress additionally tier-gates before recording progress,
-- so locked modules never accrue max_position in the first place; this reconciler stays consistent
-- with reconcile_all_xp(), which likewise derives from completed_at without a re-check.) XP is the
-- same reconcile_all_xp() derives (20 pts, ref-key 'lesson:<id>', idempotent), awarded in the same
-- run so completion and points never drift. The rebuild is a SEPARATE statement so it sees the
-- just-inserted xp_events (same-statement CTEs share one snapshot).
-- No index needed: lesson_progress is ~14k rows / 11MB — the every-15-min scan is a few ms, and a
-- non-CONCURRENT index build would lock this hot (written ~every 10s per viewer) table.

create or replace function public.reconcile_lesson_completions()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _n int := 0;
  _users uuid[];
begin
  -- 1. Fill completed_at for watched-to-threshold lessons whose completion write was lost,
  --    and award the matching lesson XP (ref-key idempotent → never double-awards; the same
  --    ref-key is used by reconcile_all_xp() and the xp_on_lesson_complete trigger).
  with filled as (
    update public.lesson_progress lp
    set completed_at = coalesce(lp.updated_at, now())
    where lp.completed_at is null
      and lp.duration_seconds_v2 is not null and lp.duration_seconds_v2 > 0
      and (lp.max_position_seconds >= lp.duration_seconds_v2 * 0.85
           or lp.max_position_seconds >= lp.duration_seconds_v2 - 20)
    returning lp.user_id, lp.lesson_id, lp.completed_at
  ),
  awarded as (
    insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
    select f.user_id, 20, 'lesson_complete', 'lesson:' || f.lesson_id::text, f.completed_at
    from filled f
    on conflict (user_id, ref_key) do nothing
    returning 1
  )
  select count(*), array_agg(distinct user_id) into _n, _users from filled;

  if _n > 0 then
    -- 2. Rebuild totals for ONLY the affected users (separate statement → sees new xp_events).
    --    Sums the full ledger per user, exactly like reconcile_all_xp() — never wipes other XP.
    insert into public.user_xp (user_id, total_xp, level, updated_at)
    select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
    from public.xp_events e
    where e.user_id = any(_users)
    group by e.user_id
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

    -- 3. DB-visible health signal: a non-zero fill means a client completion write was lost —
    --    rare and worth surfacing (incident doctrine: not a log-only error).
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_completions_reconciled', jsonb_build_object('rows', _n, 'at', now()));
    exception when others then null;
    end;
  end if;

  return _n;
end;
$fn$;

revoke execute on function public.reconcile_lesson_completions() from public, anon, authenticated;
grant execute on function public.reconcile_lesson_completions() to service_role;

-- Every 15 minutes (offset from the :55 anomaly digest and the per-minute joiner flush).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-lesson-completions') then
    perform cron.unschedule('reconcile-lesson-completions');
  end if;
  perform cron.schedule('reconcile-lesson-completions', '8,23,38,53 * * * *',
    $cmd$ select public.reconcile_lesson_completions() $cmd$);
end $$;

-- Initial backfill (0 rows at build time; establishes the baseline and proves it runs).
select public.reconcile_lesson_completions();
