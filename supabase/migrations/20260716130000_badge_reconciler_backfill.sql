-- Badge safety-net reconciler + historical backfill (2026-07-16, owner request).
-- Audit found ~800 badges EARNED but never awarded: the evaluate_* triggers only fire on the
-- write that crosses the threshold, so students who met criteria before the badge system existed,
-- or via bulk/reconciler paths, never got them (first_lesson 451 deserve/253 have, first_homework
-- 304/90, etc). This re-derives every badge from source-of-truth state — the same criteria the
-- triggers use — and awards what's missing (idempotent via user_badges' unique constraint).
--
-- Notification safety: awarding into user_badges fires trg_queue_badge_dm (one DM per badge). For
-- the ONE-TIME historical backfill we DISABLE that trigger so nobody gets ~800 old-badge pings.
-- The function is then scheduled daily WITH the trigger live, so any genuinely-new gap self-heals
-- and DOES notify (rare after backfill). Follows the "reconcilers re-derive from source-of-truth".

create or replace function public.reconcile_missing_badges()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare _n int := 0;
begin
  with deserved(user_id, earned_at, code) as (
    -- first_lesson: ≥1 lesson completed OR watched ≥30s
    select lp.user_id, min(coalesce(lp.completed_at, lp.updated_at)), 'first_lesson'
    from lesson_progress lp
    where lp.completed_at is not null or coalesce(lp.watch_seconds_total,0) >= 30
    group by lp.user_id
    union all
    -- five_lessons / ten_lessons: time of the Nth completion (COUNT semantics match the trigger)
    select user_id, earned_at, 'five_lessons' from (
      select user_id, completed_at as earned_at,
        row_number() over (partition by user_id order by completed_at) rn
      from lesson_progress where completed_at is not null) z where rn = 5
    union all
    select user_id, earned_at, 'ten_lessons' from (
      select user_id, completed_at as earned_at,
        row_number() over (partition by user_id order by completed_at) rn
      from lesson_progress where completed_at is not null) z where rn = 10
    union all
    -- module_complete: all published lessons of at least one module done
    select lp.user_id, max(lp.completed_at), 'module_complete'
    from lesson_progress lp join lessons l on l.id = lp.lesson_id and l.published
    where lp.completed_at is not null
    group by lp.user_id, l.module_id
    having count(distinct lp.lesson_id) = (select count(*) from lessons x where x.module_id = l.module_id and x.published)
    union all
    -- course_complete: all published lessons of at least one course done
    select lp.user_id, max(lp.completed_at), 'course_complete'
    from lesson_progress lp
    join lessons l on l.id = lp.lesson_id and l.published
    join modules m on m.id = l.module_id
    where lp.completed_at is not null
    group by lp.user_id, m.course_id
    having count(distinct lp.lesson_id) = (
      select count(*) from lessons x join modules mm on mm.id = x.module_id
      where mm.course_id = m.course_id and x.published)
    union all
    -- first_homework: any submission
    select user_id, min(submitted_at), 'first_homework'
    from homework_submissions group by user_id
    union all
    -- streak badges by the longest streak ever achieved (longest_streak is a running GREATEST,
    -- never lowered — a correct proxy for "current_streak ever reached this threshold").
    select s.user_id, s.last_active_date::timestamptz, t.code from streaks s
    cross join lateral (values ('streak_3',3),('streak_7',7),('streak_14',14),
                               ('streak_30',30),('streak_60',60),('streak_100',100)) as t(code, thr)
    where coalesce(s.longest_streak, 0) >= t.thr
  ),
  ins as (
    insert into public.user_badges (user_id, badge_id, earned_at)
    select d.user_id, b.id, coalesce(d.earned_at, now())
    from deserved d
    join public.badges b on b.code = d.code
    on conflict (user_id, badge_id) do nothing
    returning 1
  )
  select count(*) into _n from ins;
  return _n;
end;
$fn$;

revoke execute on function public.reconcile_missing_badges() from public, anon, authenticated;
grant execute on function public.reconcile_missing_badges() to service_role;

-- One-time historical backfill: SILENT (disable the DM queue trigger so no ~800-ping flood).
do $$
declare _awarded int;
begin
  alter table public.user_badges disable trigger trg_queue_badge_dm;
  select public.reconcile_missing_badges() into _awarded;
  alter table public.user_badges enable trigger trg_queue_badge_dm;
  -- Audit is best-effort: a logging failure must NEVER roll back the awards just made.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'badge_backfill', jsonb_build_object('awarded', _awarded, 'at', now()));
  exception when others then null;
  end;
exception when others then
  -- never leave the trigger disabled if the backfill itself fails mid-way
  begin alter table public.user_badges enable trigger trg_queue_badge_dm; exception when others then null; end;
  raise;
end $$;

-- Ongoing self-heal: daily, WITH the DM trigger live (rare awards after backfill → they notify).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'reconcile-missing-badges') then
    perform cron.unschedule('reconcile-missing-badges');
  end if;
  perform cron.schedule('reconcile-missing-badges', '25 4 * * *',
    $cmd$ select public.reconcile_missing_badges() $cmd$);
end $$;
