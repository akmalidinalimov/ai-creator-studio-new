-- Profile & gamification Phase 1 (spec v1.1, owner-approved 2026-07-06).
-- Additive only: profiles.bio, XP ledger + levels, award triggers, backfill,
-- group-scoped leaderboard, profile_stats + public_profile RPCs.
-- instagram_handle deliberately NOT included (owner deferred).

-- ============================================================
-- (1) profiles.bio — short "just enough" bio for the profile header.
-- ============================================================
alter table public.profiles add column if not exists bio text;
do $$ begin
  alter table public.profiles
    add constraint profiles_bio_len check (bio is null or char_length(bio) <= 200);
exception when duplicate_object then null; end $$;

-- ============================================================
-- (2) XP ledger + running total. xp_events is append-only and idempotent via
--     (user_id, ref_key); user_xp holds the running total + derived level.
--     Level thresholds are quadratic: reaching level L+1 costs 50*L*(L+1) XP
--     (L2@100, L3@300, L4@600, L5@1000, L6@1500, L7@2100 ...).
-- ============================================================
create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount int not null check (amount > 0),
  reason text not null,
  ref_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, ref_key)
);
create index if not exists xp_events_user_created_idx on public.xp_events (user_id, created_at desc);

create table if not exists public.user_xp (
  user_id uuid primary key references auth.users(id) on delete cascade,
  total_xp int not null default 0,
  level int not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.xp_events enable row level security;
alter table public.user_xp enable row level security;

drop policy if exists "xp_events read own or staff" on public.xp_events;
create policy "xp_events read own or staff" on public.xp_events for select
  using (user_id = auth.uid()
         or public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'superadmin')
         or public.has_role(auth.uid(), 'teacher'));
drop policy if exists "user_xp read own or staff" on public.user_xp;
create policy "user_xp read own or staff" on public.user_xp for select
  using (user_id = auth.uid()
         or public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'superadmin')
         or public.has_role(auth.uid(), 'teacher'));
-- no insert/update/delete policies: only award_xp() (definer) writes.

create or replace function public.xp_level_for(_total int)
returns int
language sql immutable
as $$ select greatest(1, floor((50 + sqrt(2500 + 200.0 * greatest(_total, 0))) / 100))::int $$;

-- XP needed to reach the NEXT level from a given level.
create or replace function public.xp_threshold_for(_level int)
returns int
language sql immutable
as $$ select 50 * greatest(_level,1) * (greatest(_level,1) + 1) $$;

create or replace function public.award_xp(_user uuid, _amount int, _reason text, _ref text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _inserted boolean;
begin
  if _user is null or _amount is null or _amount <= 0 then return; end if;
  insert into public.xp_events (user_id, amount, reason, ref_key)
  values (_user, _amount, _reason, _ref)
  on conflict (user_id, ref_key) do nothing;
  get diagnostics _inserted = row_count;
  if _inserted then
    insert into public.user_xp as ux (user_id, total_xp, level, updated_at)
    values (_user, _amount, public.xp_level_for(_amount), now())
    on conflict (user_id) do update
      set total_xp = ux.total_xp + excluded.total_xp,
          level = public.xp_level_for(ux.total_xp + excluded.total_xp),
          updated_at = now();
  end if;
end;
$$;
revoke execute on function public.award_xp(uuid, int, text, text) from public, anon, authenticated;

-- ============================================================
-- (3) Award triggers.
--     lesson complete +20 · homework submitted +15 · homework scored 9-10 +25
--     first activity of the day +5 · streak 7d +50 · streak 30d +200
-- ============================================================
create or replace function public.xp_on_lesson_complete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.completed_at is not null and (tg_op = 'INSERT' or old.completed_at is null) then
    perform public.award_xp(new.user_id, 20, 'lesson_complete', 'lesson:' || new.lesson_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.xp_on_lesson_complete() from public, anon, authenticated;
drop trigger if exists trg_xp_lesson_complete on public.lesson_progress;
create trigger trg_xp_lesson_complete
  after insert or update of completed_at on public.lesson_progress
  for each row execute function public.xp_on_lesson_complete();

create or replace function public.xp_on_homework()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    perform public.award_xp(new.user_id, 15, 'homework_submit', 'hw_submit:' || new.assignment_id);
  elsif tg_op = 'UPDATE' and new.score is not null and new.score >= 9
        and (old.score is distinct from new.score) then
    perform public.award_xp(new.user_id, 25, 'homework_high_score', 'hw_score:' || new.assignment_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.xp_on_homework() from public, anon, authenticated;
drop trigger if exists trg_xp_homework on public.homework_submissions;
create trigger trg_xp_homework
  after insert or update of score on public.homework_submissions
  for each row execute function public.xp_on_homework();

-- daily_watch_summary gets exactly one INSERT per (user, day) => "first activity of the day".
create or replace function public.xp_on_daily_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.award_xp(new.user_id, 5, 'daily_active', 'day:' || new.watch_date);
  return new;
end;
$$;
revoke execute on function public.xp_on_daily_activity() from public, anon, authenticated;
drop trigger if exists trg_xp_daily_activity on public.daily_watch_summary;
create trigger trg_xp_daily_activity
  after insert on public.daily_watch_summary
  for each row execute function public.xp_on_daily_activity();

-- streak milestones: once per day reached (re-earned on a fresh run months later).
create or replace function public.xp_on_streak_milestone()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.current_streak = 7 then
    perform public.award_xp(new.user_id, 50, 'streak_7', 'streak7:' || new.last_active_date);
  elsif new.current_streak = 30 then
    perform public.award_xp(new.user_id, 200, 'streak_30', 'streak30:' || new.last_active_date);
  end if;
  return new;
end;
$$;
revoke execute on function public.xp_on_streak_milestone() from public, anon, authenticated;
drop trigger if exists trg_xp_streak_milestone on public.streaks;
create trigger trg_xp_streak_milestone
  after insert or update of current_streak on public.streaks
  for each row execute function public.xp_on_streak_milestone();

-- ============================================================
-- (4) Backfill from history so current students don't start at level 1 / 0 XP.
--     Same ref_keys as the triggers => idempotent, safe to re-run.
--     (Daily-activity and streak history are not reconstructable; skipped.)
-- ============================================================
-- (join auth.users: skip orphaned progress rows so the FK holds)
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select lp.user_id, 20, 'lesson_complete', 'lesson:' || lp.lesson_id, lp.completed_at
from public.lesson_progress lp
join auth.users u on u.id = lp.user_id
where lp.completed_at is not null
on conflict (user_id, ref_key) do nothing;

insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select hs.user_id, 15, 'homework_submit', 'hw_submit:' || hs.assignment_id, hs.submitted_at
from public.homework_submissions hs
join auth.users u on u.id = hs.user_id
on conflict (user_id, ref_key) do nothing;

insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select hs.user_id, 25, 'homework_high_score', 'hw_score:' || hs.assignment_id, coalesce(hs.scored_at, hs.submitted_at)
from public.homework_submissions hs
join auth.users u on u.id = hs.user_id
where hs.score is not null and hs.score >= 9
on conflict (user_id, ref_key) do nothing;

-- Rebuild running totals from the ledger (authoritative).
insert into public.user_xp (user_id, total_xp, level, updated_at)
select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
from public.xp_events e
group by e.user_id
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

-- ============================================================
-- (5) Group-scoped leaderboard: XP ranking WITHIN the caller's group only.
--     Anonymized fields only (same exposure as leaderboard_top_for_user).
-- ============================================================
create or replace function public.group_leaderboard(uid uuid, _limit int default 20)
returns table(rank int, user_id uuid, first_name text, last_initial text,
              total_xp int, level int, current_streak int, is_me boolean)
language sql stable security definer set search_path = public
as $$
  with my_group as (
    select p.group_id from profiles p where p.id = uid
  ),
  members as (
    select p.id
    from profiles p
    where p.group_id = (select group_id from my_group)
      and p.group_id is not null
      and p.status = 'active' and p.archived_at is null
  ),
  ranked as (
    select m.id as uid2,
           coalesce(x.total_xp, 0) as txp,
           coalesce(x.level, 1) as lvl,
           coalesce(s.current_streak, 0) as streak,
           row_number() over (order by coalesce(x.total_xp,0) desc,
                                       coalesce(s.current_streak,0) desc, m.id) as r
    from members m
    left join user_xp x on x.user_id = m.id
    left join streaks s on s.user_id = m.id
  )
  select ranked.r::int, ranked.uid2,
         coalesce(nullif(p.name,''), 'Talaba'),
         coalesce(left(nullif(p.last_name,''),1), ''),
         ranked.txp, ranked.lvl, ranked.streak,
         (ranked.uid2 = uid)
  from ranked
  join profiles p on p.id = ranked.uid2
  order by ranked.r
  limit _limit;
$$;
grant execute on function public.group_leaderboard(uuid, int) to authenticated;

-- ============================================================
-- (6) profile_stats: one call for the profile header + bot profile card.
-- ============================================================
create or replace function public.profile_stats(uid uuid)
returns table(
  lessons_completed int, modules_completed int,
  current_streak int, longest_streak int,
  total_xp int, level int, xp_next_level int,
  group_rank int, group_size int,
  homework_submitted int, homework_avg_score numeric,
  badges_earned int, watch_minutes_total int
)
language sql stable security definer set search_path = public
as $$
  with my as (select p.group_id, coalesce((select g.course_id from groups g where g.id = p.group_id),
                     (select e.course_id from enrollments e where e.user_id = p.id order by e.enrolled_at limit 1)) as course_id
              from profiles p where p.id = uid),
  done_lessons as (
    select lp.lesson_id from lesson_progress lp where lp.user_id = uid and lp.completed_at is not null
  ),
  mods as (
    select m.id,
           count(l.id) as n_lessons,
           count(dl.lesson_id) as n_done
    from modules m
    join lessons l on l.module_id = m.id
    left join done_lessons dl on dl.lesson_id = l.id
    where m.course_id = (select course_id from my)
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
    (select count(*) from done_lessons)::int,
    (select count(*) from mods where n_lessons > 0 and n_done = n_lessons)::int,
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

-- ============================================================
-- (7) public_profile: SAFE subset for group-mates (no email/phone/telegram).
--     Visible to self, staff, and same-group members only.
-- ============================================================
create or replace function public.public_profile(_uid uuid)
returns table(user_id uuid, first_name text, last_initial text, avatar_url text, bio text,
              group_name text, teacher_name text, level int, total_xp int, current_streak int)
language sql stable security definer set search_path = public
as $$
  select p.id,
         coalesce(nullif(p.name,''), 'Talaba'),
         coalesce(left(nullif(p.last_name,''),1), ''),
         p.avatar_url, p.bio,
         g.name,
         coalesce(nullif(tp.name,''), null),
         coalesce(x.level, 1), coalesce(x.total_xp, 0),
         coalesce(s.current_streak, 0)
  from profiles p
  left join groups g on g.id = p.group_id
  left join profiles tp on tp.id = g.teacher_id
  left join user_xp x on x.user_id = p.id
  left join streaks s on s.user_id = p.id
  where p.id = _uid
    and (
      _uid = auth.uid()
      or public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'superadmin')
      or public.has_role(auth.uid(), 'teacher')
      or (p.group_id is not null and p.group_id = (select p3.group_id from profiles p3 where p3.id = auth.uid()))
    );
$$;
grant execute on function public.public_profile(uuid) to authenticated;
