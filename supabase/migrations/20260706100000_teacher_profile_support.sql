-- Teacher profile support (Phase 1, teacher variant).
-- groups RLS is admin-only, so teachers need definer RPCs to see THEIR groups.
-- Guard pattern: caller must be the teacher themself (auth.uid() = uid), an
-- admin/superadmin, or service-role (auth.uid() is null — bot webhook).

create or replace function public.teacher_groups(uid uuid)
returns table(
  group_id uuid, group_name text, course_name text,
  total_students int, active_7d int, avg_completion_pct int, pending_homework int
)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (auth.uid() is null or auth.uid() = uid
            or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  gs as (
    select g.id, g.name, g.course_id, c.title as course_name
    from groups g
    left join courses c on c.id = g.course_id
    where g.teacher_id = uid and (select allowed from ok)
  ),
  members as (
    select p.id as student_id, p.group_id
    from profiles p
    join gs on gs.id = p.group_id
    where p.status = 'active' and p.archived_at is null
  ),
  course_lessons as (
    select gs.id as gid, count(l.id) as n
    from gs
    join modules m on m.course_id = gs.course_id
    join lessons l on l.module_id = m.id
    group by gs.id
  ),
  done as (
    select mem.group_id as gid, mem.student_id, count(lp.lesson_id) as n_done
    from members mem
    left join lesson_progress lp
      on lp.user_id = mem.student_id and lp.completed_at is not null
      and lp.lesson_id in (
        select l.id from lessons l join modules m on m.id = l.module_id
        where m.course_id = (select course_id from gs where gs.id = mem.group_id)
      )
    group by mem.group_id, mem.student_id
  ),
  act as (
    select mem.group_id as gid, count(distinct mem.student_id) as n
    from members mem
    join daily_watch_summary d on d.user_id = mem.student_id
      and d.watch_date > current_date - 7
    group by mem.group_id
  ),
  pend as (
    select mem.group_id as gid, count(*) as n
    from homework_submissions hs
    join members mem on mem.student_id = hs.user_id
    where hs.score is null
    group by mem.group_id
  )
  select gs.id, gs.name, gs.course_name,
         (select count(*)::int from members where group_id = gs.id),
         coalesce((select n from act where gid = gs.id), 0)::int,
         coalesce((select round(avg(d.n_done * 100.0 / nullif(cl.n, 0)))::int
                   from done d join course_lessons cl on cl.gid = gs.id
                   where d.gid = gs.id), 0),
         coalesce((select n from pend where gid = gs.id), 0)::int
  from gs
  order by gs.name;
$$;
grant execute on function public.teacher_groups(uuid) to authenticated;

create or replace function public.teacher_profile_stats(uid uuid)
returns table(groups_count int, students_total int, graded_total int, avg_score_given numeric)
language sql stable security definer set search_path = public
as $$
  select
    (select count(*)::int from groups g where g.teacher_id = uid),
    (select count(*)::int from profiles p join groups g on g.id = p.group_id
      where g.teacher_id = uid and p.status = 'active' and p.archived_at is null),
    (select count(*)::int from homework_submissions hs where hs.scored_by = uid and hs.score is not null),
    (select round(avg(hs.score)::numeric, 1) from homework_submissions hs
      where hs.scored_by = uid and hs.score is not null)
  where (auth.uid() is null or auth.uid() = uid
         or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role));
$$;
grant execute on function public.teacher_profile_stats(uuid) to authenticated;

-- Top students of ONE of the teacher's groups, ranked by XP (profile-consistent).
create or replace function public.teacher_group_top(uid uuid, _group_id uuid, _limit int default 5)
returns table(rank int, first_name text, last_initial text, total_xp int, level int,
              current_streak int, completed_lessons int)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select exists(
      select 1 from groups g
      where g.id = _group_id
        and (g.teacher_id = uid or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role))
    ) and (auth.uid() is null or auth.uid() = uid
           or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = _group_id and p.status = 'active' and p.archived_at is null
      and (select allowed from ok)
  ),
  ranked as (
    select m.id, m.name, m.last_name,
           coalesce(x.total_xp, 0) txp, coalesce(x.level, 1) lvl, coalesce(s.current_streak, 0) streak,
           row_number() over (order by coalesce(x.total_xp,0) desc, coalesce(s.current_streak,0) desc, m.id) r
    from members m
    left join user_xp x on x.user_id = m.id
    left join streaks s on s.user_id = m.id
  )
  select r.r::int, coalesce(nullif(r.name,''),'Talaba'), coalesce(left(nullif(r.last_name,''),1),''),
         r.txp, r.lvl, r.streak,
         (select count(*)::int from lesson_progress lp where lp.user_id = r.id and lp.completed_at is not null)
  from ranked r
  order by r.r
  limit _limit;
$$;
grant execute on function public.teacher_group_top(uuid, uuid, int) to authenticated;
