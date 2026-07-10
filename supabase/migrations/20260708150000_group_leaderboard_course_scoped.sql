-- Course-scoped group rating (2026-07-08).
-- Problem: group_leaderboard + profile_stats.group_rank ranked by LIFETIME total XP across ALL
-- courses. Dual-enrolled students carried their finished AI CREATORS 4.0 XP into the 5.0 group
-- board (e.g. a #2 with 1230 total but only 280 from 5.0), burying pure-5.0 students. Points were
-- always calculated correctly — the ranking scope was wrong.
--
-- Fix: rank a group's rating by XP earned FROM THE GROUP'S OWN COURSE (lessons + homework of that
-- course). Personal profile total XP + level stay lifetime (career achievement); only the
-- competition is made course-fair. Falls back to lifetime XP if a group has no course.

-- Per-user XP attributable to one course = lesson-complete + homework XP whose lesson/assignment
-- belongs to that course. daily_active / streak XP are course-agnostic and intentionally excluded
-- from the course score. The inner subquery pre-filters to the 3 uuid-ref reasons so the ::uuid
-- cast is always safe (never runs on 'day:<date>' refs).
create or replace function public.user_course_xp(_uid uuid, _course_id uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(ev.amount), 0)::int
  from (
    select e.amount, e.reason, split_part(e.ref_key, ':', 2)::uuid as rid
    from xp_events e
    where e.user_id = _uid
      and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
  ) ev
  where _course_id is not null
    and (
      (ev.reason = 'lesson_complete' and exists (
        select 1 from lessons l join modules m on m.id = l.module_id
        where l.id = ev.rid and m.course_id = _course_id))
      or (ev.reason in ('homework_submit', 'homework_high_score') and exists (
        select 1 from homework_assignments a join modules m on m.id = a.module_id
        where a.id = ev.rid and m.course_id = _course_id))
    );
$$;
grant execute on function public.user_course_xp(uuid, uuid) to authenticated;

-- Group rating, ranked + displayed by the group's-course XP (fallback to lifetime if no course).
create or replace function public.group_leaderboard(uid uuid, _limit int default 20)
returns table(rank int, user_id uuid, first_name text, last_initial text,
              total_xp int, level int, current_streak int, is_me boolean)
language sql stable security definer set search_path = public
as $$
  with my as (
    select p.group_id as gid,
           (select g.course_id from groups g where g.id = p.group_id) as cid
    from profiles p where p.id = uid
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = (select gid from my)
      and p.group_id is not null
      and p.status = 'active' and p.archived_at is null
  ),
  scored as (
    select m.id as uid2, m.name, m.last_name,
      case when (select cid from my) is null
           then coalesce((select x.total_xp from user_xp x where x.user_id = m.id), 0)
           else public.user_course_xp(m.id, (select cid from my)) end as score,
      coalesce((select x.level from user_xp x where x.user_id = m.id), 1) as lvl,
      coalesce((select s.current_streak from streaks s where s.user_id = m.id), 0) as streak
    from members m
  ),
  ranked as (
    select scored.*, row_number() over (order by score desc, streak desc, uid2) as r
    from scored
  )
  select ranked.r::int, ranked.uid2,
         coalesce(nullif(ranked.name, ''), 'Talaba'),
         coalesce(left(nullif(ranked.last_name, ''), 1), ''),
         ranked.score::int, ranked.lvl, ranked.streak,
         (ranked.uid2 = uid)
  from ranked
  order by ranked.r
  limit _limit;
$$;
grant execute on function public.group_leaderboard(uuid, int) to authenticated;

-- profile_stats: identical to the live definition EXCEPT group_rank is now course-scoped, so the
-- profile header rank matches the group board. total_xp / level stay lifetime.
create or replace function public.profile_stats(uid uuid)
returns table(lessons_completed int, modules_completed int, total_lessons int, total_modules int,
              current_streak int, longest_streak int, total_xp int, level int, xp_next_level int,
              group_rank int, group_size int, homework_submitted int, homework_avg_score numeric,
              badges_earned int, watch_minutes_total int)
language sql stable security definer set search_path = public
as $$
  with my as (
    select p.group_id,
           coalesce((select g.course_id from groups g where g.id = p.group_id),
                    (select e.course_id from enrollments e where e.user_id = p.id order by e.enrolled_at limit 1)) as course_id
    from profiles p where p.id = uid
  ),
  my_limit as (
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
    select m.id, count(l.id) as n_lessons, count(dl.lesson_id) as n_done
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
    select g.id, row_number() over (
      order by (case when (select course_id from my) is null
                     then coalesce((select x.total_xp from user_xp x where x.user_id = g.id), 0)
                     else public.user_course_xp(g.id, (select course_id from my)) end) desc,
               coalesce((select s.current_streak from streaks s where s.user_id = g.id), 0) desc, g.id) as r
    from grp g
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
