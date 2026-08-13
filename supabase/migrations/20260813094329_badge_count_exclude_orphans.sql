-- Badge counts must count only badges that still have a DEFINITION (exist in `badges`).
--
-- Finding (audit 2026-08-13): 2,274 user_badges reference badge_ids NOT in the 14-row `badges`
-- catalog — historical rows imported from a previous system during the platform migration (a
-- replica-mode restore that bypassed the validated FK user_badges.badge_id → badges(id)). They can't
-- render (no definition) and the Badges page already ignores them, but the COUNT surfaces
-- (admin_course_group_stats.badges_earned/students_with_badges, profile_stats.badges_earned, and two
-- frontend tiles) counted raw user_badges rows, over-counting badges for ~active students (6 showed
-- >14 badges — impossible with 14 types). Verified read-only: every qualified active student already
-- holds the CURRENT-catalog badge (0 missing across first_lesson/streak_3/streak_7/level_5/five_lessons),
-- so the orphans are pure duplicates — excluding them from the count loses nothing, and makes the count
-- match what's actually displayable. XP, leaderboards, and homework were all verified correct.
--
-- Fix: join `badges` in every badge COUNT (this file + the two frontend tiles, shipped alongside) so
-- only defined badges count. The orphan ROWS are left in place (non-destructive; a separate cleanup can
-- remove them). A watchdog guards against NEW orphans (the FK blocks normal inserts, so only another
-- bulk import could reintroduce them).

-- 1. admin_course_group_stats: identical to 20260810190000 EXCEPT the bdg CTE now joins `badges`
--    (count only defined badges).
create or replace function public.admin_course_group_stats(_course_id uuid, _window_days int default 7)
returns table(
  group_id uuid, group_name text, tier_name text, teacher_name text,
  total_students int, active_students int, activated_count int,
  badges_earned int, students_with_badges int,
  avg_completion_pct int, accessible_lessons int,
  total_xp bigint, avg_xp int,
  homework_submitted int, homework_avg_score numeric, pending_homework int
)
language sql
stable
security definer
set search_path = public
as $$
  with ok as (
    select (auth.uid() is null
            or has_role(auth.uid(), 'admin'::app_role)
            or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  gs as (
    select g.id as gid, g.name as gname, g.tier_id, ct.name as tier_name, ct.module_limit,
           coalesce(nullif(trim(concat(tp.name, ' ', coalesce(tp.last_name, ''))), ''), tp.email) as teacher_name
    from groups g
    left join course_tiers ct on ct.id = g.tier_id
    left join profiles tp on tp.id = g.teacher_id
    where g.course_id = _course_id and (select allowed from ok)
  ),
  members as (
    select p.id as student_id, p.group_id as gid
    from profiles p
    join gs on gs.gid = p.group_id
    where p.status = 'active' and p.archived_at is null
  ),
  grp_modules as (
    select gs.gid, m.id as module_id, gs.module_limit,
      row_number() over (partition by gs.gid order by m.position, m.created_at) as rn
    from gs
    join modules m on m.course_id = _course_id
  ),
  grp_lessons as (
    select gm.gid, l.id as lesson_id
    from grp_modules gm
    join lessons l on l.module_id = gm.module_id
    where gm.module_limit is null or gm.rn <= gm.module_limit
  ),
  grp_lesson_count as (
    select gid, count(*)::int as n from grp_lessons group by gid
  ),
  done as (
    select mem.gid, mem.student_id, count(lp.lesson_id) as n_done
    from members mem
    join grp_lessons gl on gl.gid = mem.gid
    left join lesson_progress lp
      on lp.user_id = mem.student_id and lp.lesson_id = gl.lesson_id and lp.completed_at is not null
    group by mem.gid, mem.student_id
  ),
  completion as (
    select d.gid, round(avg(d.n_done * 100.0 / nullif(glc.n, 0)))::int as avg_completion_pct
    from done d join grp_lesson_count glc on glc.gid = d.gid
    group by d.gid
  ),
  act as (
    select mem.gid, count(distinct mem.student_id) as n
    from members mem
    join lesson_progress lp on lp.user_id = mem.student_id
      and lp.updated_at >= now() - make_interval(days => _window_days)
    group by mem.gid
  ),
  activated as (
    select mem.gid, count(distinct mem.student_id) as n
    from members mem
    join auth.users au on au.id = mem.student_id and au.last_sign_in_at is not null
    group by mem.gid
  ),
  bdg as (
    select mem.gid, count(ub.id)::int as n, count(distinct ub.user_id)::int as students_with
    from members mem
    join user_badges ub on ub.user_id = mem.student_id
    join badges bd on bd.id = ub.badge_id   -- only count badges with a live definition (exclude imported orphans)
    group by mem.gid
  ),
  xp as (
    select mem.gid,
      coalesce(sum(public.user_course_xp(mem.student_id, _course_id)), 0)::bigint as total,
      coalesce(round(avg(public.user_course_xp(mem.student_id, _course_id))), 0)::int as avg
    from members mem
    group by mem.gid
  ),
  hw as (
    select mem.gid,
      count(*)::int as submitted,
      round(avg(hs.score) filter (where hs.score is not null), 1) as avg_score,
      count(*) filter (where hs.score is null and hs.submitted_at is not null)::int as pending
    from homework_submissions hs
    join members mem on mem.student_id = hs.user_id
    join homework_assignments ha on ha.id = hs.assignment_id
    join modules m2 on m2.id = ha.module_id and m2.course_id = _course_id
    group by mem.gid
  )
  select gs.gid, gs.gname, gs.tier_name,
         coalesce(gs.teacher_name, '—'),
         (select count(*)::int from members where gid = gs.gid),
         coalesce((select n from act where gid = gs.gid), 0)::int,
         coalesce((select n from activated where gid = gs.gid), 0)::int,
         coalesce((select n from bdg where gid = gs.gid), 0)::int,
         coalesce((select students_with from bdg where gid = gs.gid), 0)::int,
         coalesce((select avg_completion_pct from completion where gid = gs.gid), 0)::int,
         coalesce((select n from grp_lesson_count where gid = gs.gid), 0)::int,
         coalesce((select total from xp where gid = gs.gid), 0)::bigint,
         coalesce((select avg from xp where gid = gs.gid), 0)::int,
         coalesce((select submitted from hw where gid = gs.gid), 0)::int,
         (select avg_score from hw where gid = gs.gid)::numeric,
         coalesce((select pending from hw where gid = gs.gid), 0)::int
  from gs
  order by gs.gname;
$$;
revoke execute on function public.admin_course_group_stats(uuid, int) from public, anon;
grant execute on function public.admin_course_group_stats(uuid, int) to authenticated, service_role;

-- 2. profile_stats: identical to 20260711150000 EXCEPT the badges_earned count now joins `badges`.
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
    coalesce((select round(sum(dws.total_seconds) / 60.0)::int from daily_watch_summary dws where dws.user_id = uid), 0);
$$;
-- Grant matches the original profile_stats lineage exactly (authenticated only). The pre-existing PUBLIC
-- EXECUTE grant is left UNCHANGED here — tightening it is a separate, independently-verified security
-- change, deliberately NOT bundled into this badge-count fix.
grant execute on function public.profile_stats(uuid) to authenticated;

-- 3. Detector: health signal + watchdog that alerts admins if NEW orphans appear beyond the captured
--    baseline (the FK blocks normal inserts, so growth means another bulk import/re-seed bypassed it).
create or replace function public.badge_orphan_stats()
returns jsonb
language sql stable security definer set search_path = public
as $fn$
  select jsonb_build_object(
    'orphan_user_badges', (select count(*) from user_badges ub where not exists (select 1 from badges b where b.id = ub.badge_id)),
    'baseline', (select (value->>'count')::int from platform_settings where key = 'badge_orphan_baseline'),
    'checked_at', now()
  );
$fn$;
revoke execute on function public.badge_orphan_stats() from public, anon, authenticated;

create or replace function public.badge_orphan_watchdog()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  _cur int; _base int; _tok text; _admin record; _sent int := 0;
begin
  select count(*) into _cur from user_badges ub where not exists (select 1 from badges b where b.id = ub.badge_id);
  select (value->>'count')::int into _base from platform_settings where key = 'badge_orphan_baseline';

  -- First run OR fewer orphans (a cleanup ran): (re)set the baseline, stay silent.
  if _base is null or _cur <= _base then
    insert into platform_settings (key, value, updated_at)
    values ('badge_orphan_baseline', jsonb_build_object('count', _cur, 'at', now()), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
    return 0;
  end if;

  -- _cur > _base → NEW orphans appeared. Alert admins, then re-baseline so it alerts once per jump.
  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is not null and _tok <> '' then
    for _admin in
      select distinct p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          headers := jsonb_build_object('Content-Type','application/json'),
          body := jsonb_build_object('chat_id', _admin.telegram_id,
            'text', '⚠️ Yangi "yetim" nishonlar: +' || (_cur - _base) || ' (jami ' || _cur || ').' ||
                    E'\nuser_badges.badge_id `badges` jadvalida yo''q — import/re-seed FK ni chetlab o''tgan.' ||
                    E'\nSanoqlar faqat mavjud nishonlarni hisoblaydi; sababi tekshirilsin.'));
        _sent := _sent + 1;
      exception when others then null; end;
    end loop;
  end if;

  insert into platform_settings (key, value, updated_at)
  values ('badge_orphan_baseline', jsonb_build_object('count', _cur, 'at', now()), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'badge_orphan_watchdog_alert', jsonb_build_object('cur', _cur, 'base', _base, 'new', _cur - _base, 'sent', _sent, 'at', now()));
  exception when others then null; end;

  return _sent;
end;
$$;
revoke execute on function public.badge_orphan_watchdog() from public, anon, authenticated;

-- 4. Schedule daily (05:40 UTC, offset from the other watchdogs) + prime the baseline once (silent on
--    the current known set). The prime is wrapped so a failure can't roll back the file.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'badge-orphan-watchdog') then
    perform cron.unschedule('badge-orphan-watchdog');
  end if;
  perform cron.schedule('badge-orphan-watchdog', '40 5 * * *', $cmd$ select public.badge_orphan_watchdog() $cmd$);
  begin
    perform public.badge_orphan_watchdog();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'badge_orphan_watchdog_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
