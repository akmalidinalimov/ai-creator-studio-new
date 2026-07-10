-- Teacher leaderboard (2026-07-08) — Teacher Engagement, Phase 4 (friendly competition).
-- Designed the safe way per the research:
--   * WEEKLY score (XP earned this Tashkent-week from teacher_* reasons) — auto-resets every week,
--     so a bad week never buries anyone and tenure/backfill never dominates.
--   * MOVEMENT: also returns last week's rank + xp so the surface can show ↑/↓ and "team this week".
--   * RECOGNITION-only: no prizes; status is the reward. Team total is derivable from the rows,
--     so surfaces can frame it as "our ustozlar this week" (collectivist-friendly) alongside rank.
--   * Visible to teachers/admins only (participants), not students.
-- With a small teaching team this is a single board; when teacher count grows, scope by course.

create or replace function public.teacher_leaderboard(uid uuid, _limit int default 30)
returns table(
  rank int, prev_rank int, teacher_id uuid, first_name text, last_initial text,
  week_xp int, prev_week_xp int, is_me boolean
)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (auth.uid() is null or has_role(auth.uid(), 'teacher'::app_role)
            or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  bounds as (
    select
      (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent') as ws
  ),
  win as (
    select ws, (ws - interval '7 days') as ls from bounds
  ),
  teachers as (
    select ur.user_id as tid from user_roles ur where ur.role = 'teacher'::app_role
  ),
  wk as (
    select e.user_id as tid,
      coalesce(sum(e.amount) filter (where e.created_at >= (select ws from win)), 0)::int as week_xp,
      coalesce(sum(e.amount) filter (where e.created_at >= (select ls from win) and e.created_at < (select ws from win)), 0)::int as prev_week_xp
    from xp_events e
    where e.reason like 'teacher_%' and e.created_at >= (select ls from win)
    group by e.user_id
  ),
  ranked as (
    select t.tid,
      coalesce(w.week_xp, 0) as week_xp,
      coalesce(w.prev_week_xp, 0) as prev_week_xp,
      row_number() over (order by coalesce(w.week_xp, 0) desc, t.tid) as r,
      row_number() over (order by coalesce(w.prev_week_xp, 0) desc, t.tid) as prev_r
    from teachers t left join wk w on w.tid = t.tid
  )
  select r.r::int, r.prev_r::int, r.tid,
    coalesce(nullif(p.name, ''), 'Ustoz'), coalesce(left(nullif(p.last_name, ''), 1), ''),
    r.week_xp, r.prev_week_xp, (r.tid = uid)
  from ranked r
  join profiles p on p.id = r.tid
  where (select allowed from ok)
  order by r.r
  limit _limit;
$$;
grant execute on function public.teacher_leaderboard(uuid, int) to authenticated;
