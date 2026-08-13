-- Security hardening (audit follow-up 2026-08-13): close anon access to per-user stat functions and
-- two internal write helpers.
--
-- Finding: `profile_stats(uid)` was SECURITY DEFINER with NO caller check → the public anon key could
-- read ANY student's stats (XP/level/rank/homework avg/badges/watch minutes) by passing any uid. The
-- sibling `teacher_profile_stats` had a guard but used `auth.uid() is null` — which is TRUE for anon
-- (verified: anon → auth.uid()=NULL, auth.role()='anon'), so it ALSO leaked to anon. The correct guard
-- keys off `auth.role() = 'service_role'` to allow the bot/cron (service role) while blocking anon.
-- Two write helpers — `award_badge(uid,_code)` (inserts a badge) and `bump_streak_for_user(uid)`
-- (updates a streak) — were anon-callable too (an unauthorized WRITE, higher severity than the read
-- leak). They are internal-only: every caller is a SECURITY DEFINER trigger (runs as owner) or the
-- notify-badge-award edge fn (service_role), so revoking anon/authenticated EXECUTE breaks nothing.
--
-- Defense in depth: the WHERE guard blocks the data leak (anon gets 0 rows), AND the implicit default
-- PUBLIC/anon EXECUTE is revoked so anon cannot invoke these RPCs at all. Grants keep authenticated
-- (frontend) + service_role (bot/cron).
--
-- Scope: this closes the reported leak + its direct sibling + the 2 writes. The broader class of other
-- uid-taking functions that leak to anon via the same `auth.uid() is null` pattern (leaderboards, etc.)
-- is a tracked follow-up — several are used inside RLS policies and need per-function analysis, so they
-- are intentionally NOT swept here.

-- 1. profile_stats: identical to 20260813094329 EXCEPT the final select now carries a caller guard
--    (service role OR self OR admin/superadmin). Anon / cross-user callers get 0 rows.
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
    (select count(*)::int from user_badges ub join badges bd on bd.id = ub.badge_id where ub.user_id = uid),
    coalesce((select round(sum(dws.total_seconds) / 60.0)::int from daily_watch_summary dws where dws.user_id = uid), 0)
  where (auth.role() = 'service_role'                    -- bot / cron (service key)
         or auth.uid() = uid                             -- the student viewing their own profile
         or has_role(auth.uid(), 'admin'::app_role)
         or has_role(auth.uid(), 'superadmin'::app_role));
$$;
revoke execute on function public.profile_stats(uuid) from public, anon;
grant execute on function public.profile_stats(uuid) to authenticated, service_role;

-- 2. teacher_profile_stats: same shape as the live def, EXCEPT the guard's leaky `auth.uid() is null`
--    (true for anon) is replaced with `auth.role() = 'service_role'`.
create or replace function public.teacher_profile_stats(uid uuid)
returns table(groups_count integer, students_total integer, graded_total integer, avg_score_given numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::int from groups g where g.teacher_id = uid),
    (select count(*)::int from profiles p join groups g on g.id = p.group_id
      where g.teacher_id = uid and p.status = 'active' and p.archived_at is null),
    (select count(*)::int from homework_submissions hs where hs.scored_by = uid and hs.score is not null),
    (select round(avg(hs.score)::numeric, 1) from homework_submissions hs
      where hs.scored_by = uid and hs.score is not null)
  where (auth.role() = 'service_role' or auth.uid() = uid
         or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role));
$$;
revoke execute on function public.teacher_profile_stats(uuid) from public, anon;
grant execute on function public.teacher_profile_stats(uuid) to authenticated, service_role;

-- 3. Internal write helpers — remove the default PUBLIC/anon/authenticated EXECUTE. Every real caller is
--    a SECURITY DEFINER trigger (runs as owner, unaffected) or the notify-badge-award edge fn
--    (service_role). This closes an anon-write hole (award any badge / bump any streak).
revoke execute on function public.award_badge(uuid, text) from public, anon, authenticated;
grant execute on function public.award_badge(uuid, text) to service_role;

revoke execute on function public.bump_streak_for_user(uuid) from public, anon, authenticated;
