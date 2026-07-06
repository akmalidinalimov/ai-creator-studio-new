-- profile_stats v2: add course totals (tier-clamped) so the profile's course
-- donut has a denominator. Return type changes => drop + recreate.

drop function if exists public.profile_stats(uuid);

create or replace function public.profile_stats(uid uuid)
returns table(
  lessons_completed int, modules_completed int,
  total_lessons int, total_modules int,
  current_streak int, longest_streak int,
  total_xp int, level int, xp_next_level int,
  group_rank int, group_size int,
  homework_submitted int, homework_avg_score numeric,
  badges_earned int, watch_minutes_total int
)
language sql stable security definer set search_path = public
as $$
  with my as (
    select p.group_id,
           coalesce((select g.course_id from groups g where g.id = p.group_id),
                    (select e.course_id from enrollments e where e.user_id = p.id order by e.enrolled_at limit 1)) as course_id
    from profiles p where p.id = uid
  ),
  my_limit as (
    -- tier clamp: the student's module_limit for their course (null = unlimited)
    select ct.module_limit
    from enrollments e
    join course_tiers ct on ct.id = e.tier_id
    where e.user_id = uid and e.course_id = (select course_id from my)
    limit 1
  ),
  course_modules as (
    select m.id, row_number() over (order by m.position, m.created_at) as rnk
    from modules m
    where m.course_id = (select course_id from my)
  ),
  tier_modules as (
    select id from course_modules
    where (select module_limit from my_limit) is null
       or rnk <= (select module_limit from my_limit)
  ),
  done_lessons as (
    select lp.lesson_id from lesson_progress lp where lp.user_id = uid and lp.completed_at is not null
  ),
  mods as (
    select m.id,
           count(l.id) as n_lessons,
           count(dl.lesson_id) as n_done
    from tier_modules m
    join lessons l on l.module_id = m.id
    left join done_lessons dl on dl.lesson_id = l.id
    group by m.id
  ),
  grp as (
    select p2.id from profiles p2
    where p2.group_id = (select group_id from my) and p2.group_id is not null
      and p2.status = 'active' and p2.archived_at is null
  ),
  grp_ranked as (
    select g.id, row_number() over (order by coalesce(x.total_xp,0) desc,
                                             coalesce(s.current_streak,0) desc, g.id) as r
    from grp g
    left join user_xp x on x.user_id = g.id
    left join streaks s on s.user_id = g.id
  )
  select
    (select coalesce(sum(n_done),0) from mods)::int,
    (select count(*) from mods where n_lessons > 0 and n_done = n_lessons)::int,
    (select coalesce(sum(n_lessons),0) from mods)::int,
    (select count(*) from mods where n_lessons > 0)::int,
    coalesce((select s.current_streak from streaks s where s.user_id = uid), 0),
    coalesce((select s.longest_streak from streaks s where s.user_id = uid), 0),
    coalesce((select x.total_xp from user_xp x where x.user_id = uid), 0),
    coalesce((select x.level from user_xp x where x.user_id = uid), 1),
    public.xp_threshold_for(coalesce((select x.level from user_xp x where x.user_id = uid), 1)),
    (select r::int from grp_ranked where id = uid),
    (select count(*)::int from grp),
    (select count(*)::int from homework_submissions hs where hs.user_id = uid),
    (select round(avg(hs.score)::numeric, 1) from homework_submissions hs where hs.user_id = uid and hs.score is not null),
    (select count(*)::int from user_badges ub where ub.user_id = uid),
    coalesce((select round(sum(dws.total_seconds) / 60.0)::int from daily_watch_summary dws where dws.user_id = uid), 0);
$$;
grant execute on function public.profile_stats(uuid) to authenticated;
