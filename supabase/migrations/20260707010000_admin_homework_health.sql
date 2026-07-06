-- A1: all-groups homework health board (admin). One row per group with the
-- signals that answer "which group is falling behind?" at a glance.

create or replace function public.admin_homework_health()
returns table(
  group_id uuid, group_name text, course_name text, teacher_name text,
  students int, active_7d int,
  submissions_total int, pending int, graded_pct int,
  median_wait_days numeric, avg_score numeric
)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (has_role(auth.uid(),'admin'::app_role) or has_role(auth.uid(),'superadmin'::app_role)
            or auth.uid() is null) as allowed
  ),
  g as (
    select g.id, g.name, c.title course, tp.name tname
    from groups g
    left join courses c on c.id = g.course_id
    left join profiles tp on tp.id = g.teacher_id
    where (select allowed from ok)
  ),
  mem as (
    select p.group_id gid, p.id sid from profiles p
    where p.status='active' and p.archived_at is null and p.group_id is not null
  ),
  subs as (
    select m.gid, hs.score, hs.score_is_stale, hs.submitted_at, hs.scored_at
    from homework_submissions hs join mem m on m.sid = hs.user_id
  )
  select g.id, g.name, g.course, coalesce(g.tname,'—'),
    (select count(*)::int from mem where gid = g.id),
    (select count(distinct d.user_id)::int from daily_watch_summary d join mem m2 on m2.sid = d.user_id
      where m2.gid = g.id and d.watch_date > current_date - 7),
    (select count(*)::int from subs where gid = g.id),
    (select count(*)::int from subs where gid = g.id and (score is null or score_is_stale)),
    coalesce((select round(count(*) filter (where score is not null and not coalesce(score_is_stale,false)) * 100.0
              / nullif(count(*),0))::int from subs where gid = g.id), 0),
    (select round((percentile_cont(0.5) within group (order by extract(epoch from (scored_at - submitted_at))/86400.0))::numeric, 1)
      from subs where gid = g.id and scored_at is not null),
    (select round(avg(score)::numeric, 1) from subs where gid = g.id and score is not null)
  from g order by g.course, g.name;
$$;
grant execute on function public.admin_homework_health() to authenticated;
