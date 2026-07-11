-- Group rating = account points minus OTHER courses' content (2026-07-11).
-- Owner report: a student sees 555 points in his account but 390..415 in the group rating.
-- The 2026-07-08 course-scoping (user_course_xp) fixed finished-4.0 XP inflating 5.0 boards,
-- but it over-corrected: it counted ONLY course content (lessons/homework), silently dropping
-- daily_active (+5/watch-day) and streak bonuses — so "watch a video, gain a point" never moved
-- the group rating. New rule:
--
--   rating = total_xp − content XP that resolves to a DIFFERENT course
--
-- • Single-course students (the vast majority): rating == account points, exactly.
-- • Dual-enrolled students: other-course lessons/homework still excluded (the July-8 guarantee),
--   but their watching/streak activity counts like everyone else's.
-- • Orphaned refs (deleted lessons) stay included — they're part of the account total the
--   student can see, and excluding them recreates the mismatch.

create or replace function public.user_group_rating_xp(_uid uuid, _course_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select x.total_xp from user_xp x where x.user_id = _uid), 0)
       - coalesce((
           select sum(e.amount)::int
           from xp_events e
           where e.user_id = _uid
             and e.reason in ('lesson_complete', 'homework_submit', 'homework_high_score')
             and (
               (e.reason = 'lesson_complete' and exists (
                 select 1 from lessons l join modules m on m.id = l.module_id
                 where l.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id))
               or (e.reason in ('homework_submit', 'homework_high_score') and exists (
                 select 1 from homework_assignments a join modules m on m.id = a.module_id
                 where a.id = split_part(e.ref_key, ':', 2)::uuid and m.course_id <> _course_id))
             )
         ), 0);
$$;
revoke execute on function public.user_group_rating_xp(uuid, uuid) from public, anon;
grant execute on function public.user_group_rating_xp(uuid, uuid) to authenticated;

create or replace function public.group_leaderboard(uid uuid, _limit integer default 20)
returns table(rank integer, user_id uuid, first_name text, last_initial text, total_xp integer, level integer, current_streak integer, is_me boolean)
language sql
stable
security definer
set search_path = public
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
           else public.user_group_rating_xp(m.id, (select cid from my)) end as score,
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

create or replace function public.profile_stats(uid uuid)
returns table(lessons_completed integer, modules_completed integer, total_lessons integer, total_modules integer, current_streak integer, longest_streak integer, total_xp integer, level integer, xp_next_level integer, group_rank integer, group_size integer, homework_submitted integer, homework_avg_score numeric, badges_earned integer, watch_minutes_total integer)
language sql
stable
security definer
set search_path = public
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
                     else public.user_group_rating_xp(g.id, (select course_id from my)) end) desc,
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
