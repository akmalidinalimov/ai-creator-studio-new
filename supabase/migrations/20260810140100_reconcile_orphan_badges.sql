-- Q6 follow-up — give level_5 + perfect_score the same daily self-heal as every other badge.
-- The incident doctrine requires each badge to have BOTH the instant trigger (20260810140000) AND a
-- reconciler leg that re-derives from source-of-truth. reconcile_missing_badges() (20260716130000)
-- did not cover the two new badges, so a future trigger-miss would strand qualifiers permanently.
-- This recreates the function VERBATIM with two added UNION ALL branches. No backfill here
-- (20260810140000 already did the one-time silent backfill); the daily 'reconcile-missing-badges'
-- cron picks up this new body automatically. Idempotent (award via user_badges' unique constraint).

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
    union all
    -- level_5: XP level reached 5 (mirrors trg_award_level_badges)
    select ux.user_id, ux.updated_at, 'level_5'
    from user_xp ux where ux.level >= 5
    union all
    -- perfect_score: any homework scored to the assignment max, NULL max treated as 10
    -- (mirrors trg_award_perfect_score)
    select hs.user_id, hs.scored_at, 'perfect_score'
    from homework_submissions hs
    join homework_assignments ha on ha.id = hs.assignment_id
    where hs.score is not null and hs.score >= coalesce(ha.max_score, 10)
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
