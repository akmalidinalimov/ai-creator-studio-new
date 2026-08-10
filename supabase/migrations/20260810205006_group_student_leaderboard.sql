-- Daily group board: per-group student leaderboards for the teacher/admin digest + Mini App.
-- Two boards per group, both scored EXACTLY like the live /leaderboard page and profile_stats():
--   * 🏆 all-time  — public.user_group_rating_xp(uid, course) = account points minus OTHER courses'
--                    content XP. This is the SAME primitive group_leaderboard() + profile_stats()
--                    switched to in 20260711150000 (so a student's number here matches their profile
--                    and the public board — NOT user_course_xp(), which drops daily_active/streak XP
--                    and caused the "555 in account, 390 on board" mismatch incident).
--   * 🔥 this week — the windowed analog: XP that counts toward the rating earned since Monday 00:00
--                    Asia/Tashkent (calendar week → resets every Monday, keeping the race fresh).
-- Names are first-name + last-initial (matches group_leaderboard / the public board — privacy-safe).
-- Guard mirrors admin_course_group_stats: service role (cron/edge fn, auth.uid() null), an
-- admin/superadmin, OR the teacher who owns the group. NEVER exposes a "bottom" list (top-N only).

-- Windowed group-rating XP: identical shape to user_group_rating_xp (20260711150000) — total minus
-- other-course content — but both sums are floored at _since. A null _course_id yields the plain
-- windowed total (the `m.course_id <> null` predicate is never true), matching user_group_rating_xp's
-- own courseless behavior. The ::uuid cast only runs inside the content-reason-filtered subquery.
create or replace function public.user_group_rating_xp_since(_uid uuid, _course_id uuid, _since timestamptz)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce((
           select sum(e.amount)::int from xp_events e
           where e.user_id = _uid and e.created_at >= _since
         ), 0)
       - coalesce((
           select sum(e.amount)::int
           from xp_events e
           where e.user_id = _uid
             and e.created_at >= _since
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
revoke execute on function public.user_group_rating_xp_since(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.user_group_rating_xp_since(uuid, uuid, timestamptz) to authenticated, service_role;

create or replace function public.group_student_leaderboard(_group_id uuid, _limit int default 10)
returns table(board text, rank int, user_id uuid, first_name text, last_initial text,
              xp int, level int, current_streak int)
language sql stable security definer set search_path = public
as $$
  with ok as (
    select (auth.uid() is null
            or has_role(auth.uid(), 'admin'::app_role)
            or has_role(auth.uid(), 'superadmin'::app_role)
            or exists (select 1 from groups g where g.id = _group_id and g.teacher_id = auth.uid())
           ) as allowed
  ),
  ctx as (
    select g.course_id as cid,
           -- Monday 00:00 in Tashkent, back to a timestamptz for the created_at comparison.
           (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent') as weekstart
    from groups g
    where g.id = _group_id and (select allowed from ok)
  ),
  members as (
    select p.id, p.name, p.last_name
    from profiles p
    where p.group_id = _group_id
      and p.status = 'active' and p.archived_at is null
      and (select allowed from ok)
  ),
  scored as (
    select m.id, m.name, m.last_name,
      -- Same primitive the /leaderboard page + profile header rank use → numbers match everywhere.
      public.user_group_rating_xp(m.id, (select cid from ctx)) as alltime_xp,
      public.user_group_rating_xp_since(m.id, (select cid from ctx), (select weekstart from ctx)) as weekly_xp,
      coalesce((select x.level from user_xp x where x.user_id = m.id), 1) as lvl,
      coalesce((select s.current_streak from streaks s where s.user_id = m.id), 0) as streak
    from members m
  ),
  alltime as (
    select 'alltime'::text as board,
      row_number() over (order by alltime_xp desc, streak desc, id) as r,
      id, name, last_name, alltime_xp as xp, lvl, streak
    from scored
  ),
  weekly as (
    select 'weekly'::text as board,
      row_number() over (order by weekly_xp desc, streak desc, id) as r,
      id, name, last_name, weekly_xp as xp, lvl, streak
    from scored
    where weekly_xp > 0   -- only students who actually earned XP this week appear as "champions"
  )
  select u.board, u.r::int, u.id,
         coalesce(nullif(u.name, ''), 'Talaba'),
         coalesce(left(nullif(u.last_name, ''), 1), ''),
         u.xp::int, u.lvl, u.streak
  from (
    select * from alltime where r <= _limit
    union all
    select * from weekly where r <= _limit
  ) u
  order by u.board, u.r;
$$;
revoke execute on function public.group_student_leaderboard(uuid, int) from public, anon;
grant execute on function public.group_student_leaderboard(uuid, int) to authenticated, service_role;

-- Kill-switch for the digest board section (turn off without a deploy). The Mini App stays usable.
insert into platform_settings(key, value)
select 'group_board', '{"digest_enabled": true}'::jsonb
where not exists (select 1 from platform_settings where key = 'group_board');
