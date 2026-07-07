-- Teacher XP engine (2026-07-08) — Teacher Engagement, Phase 1.
-- Reuses the GENERIC gamification engine (award_xp / user_xp / xp_level_for) built for students —
-- no changes to any of it. Adds ONLY teacher-side award paths + a read RPC.
--
-- Design (grounded in the research): points reward CONTROLLABLE process behaviors a teacher owns
-- (grading, showing up), never student outcomes. Every SPEED reward is paired with a QUALITY guard
-- so we never incentivize rubber-stamped grades.
--
--   +10  graded a submission            (per submission, idempotent)
--   +15  graded ON TIME (<=24h) AND wrote real feedback (>=10 chars)   <- speed + quality together
--   +5   first grade of the day         (per grader per Tashkent-day, idempotent)
--
-- Awards go to hs.scored_by (whoever actually graded). Teacher/admin XP rows in user_xp are
-- isolated: the student leaderboards (leaderboard_cache, group_leaderboard) exclude staff, so this
-- never pollutes student rankings.

-- ============================================================
-- (1) Award trigger on the grading write path.
-- ============================================================
create or replace function public.xp_on_teacher_grade()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _grader uuid := new.scored_by;
  _day text;
begin
  -- Only fire on a real grading event (a grader set a score).
  if new.score is null or _grader is null then return new; end if;
  -- On UPDATE, skip if neither the score nor the grader actually changed (no new grading work).
  if tg_op = 'UPDATE'
     and old.score is not distinct from new.score
     and old.scored_by is not distinct from new.scored_by then
    return new;
  end if;

  -- base: graded a submission (idempotent per submission id)
  perform public.award_xp(_grader, 10, 'teacher_grade', 'tgrade:' || new.id);

  -- on-time bonus: within 24h AND with real feedback — never reward speed alone.
  if new.scored_at is not null and new.submitted_at is not null
     and (new.scored_at - new.submitted_at) <= interval '24 hours'
     and char_length(btrim(coalesce(new.score_feedback, ''))) >= 10 then
    perform public.award_xp(_grader, 15, 'teacher_grade_ontime', 'tgradeontime:' || new.id);
  end if;

  -- first grade of the day => active teaching day (idempotent per grader + Tashkent day)
  _day := ((now() at time zone 'Asia/Tashkent')::date)::text;
  perform public.award_xp(_grader, 5, 'teacher_active_day', 'tday:' || _grader::text || ':' || _day);

  return new;
end;
$$;
revoke execute on function public.xp_on_teacher_grade() from public, anon, authenticated;
drop trigger if exists trg_xp_teacher_grade on public.homework_submissions;
create trigger trg_xp_teacher_grade
  after insert or update of score on public.homework_submissions
  for each row execute function public.xp_on_teacher_grade();

-- ============================================================
-- (2) Backfill from history so active teachers don't start at level 1 / 0 XP.
--     Same ref_keys as the trigger => idempotent, safe to re-run.
-- ============================================================
-- base grade XP
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select hs.scored_by, 10, 'teacher_grade', 'tgrade:' || hs.id, coalesce(hs.scored_at, hs.submitted_at, now())
from public.homework_submissions hs
join auth.users u on u.id = hs.scored_by
where hs.scored_by is not null and hs.score is not null
on conflict (user_id, ref_key) do nothing;

-- on-time + feedback bonus
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select hs.scored_by, 15, 'teacher_grade_ontime', 'tgradeontime:' || hs.id, coalesce(hs.scored_at, hs.submitted_at)
from public.homework_submissions hs
join auth.users u on u.id = hs.scored_by
where hs.scored_by is not null and hs.score is not null
  and hs.scored_at is not null and hs.submitted_at is not null
  and (hs.scored_at - hs.submitted_at) <= interval '24 hours'
  and char_length(btrim(coalesce(hs.score_feedback, ''))) >= 10
on conflict (user_id, ref_key) do nothing;

-- one active-day per grader per Tashkent day they graded
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select hs.scored_by, 5, 'teacher_active_day',
       'tday:' || hs.scored_by::text || ':' || ((hs.scored_at at time zone 'Asia/Tashkent')::date)::text,
       min(hs.scored_at)
from public.homework_submissions hs
join auth.users u on u.id = hs.scored_by
where hs.scored_by is not null and hs.score is not null and hs.scored_at is not null
group by hs.scored_by, ((hs.scored_at at time zone 'Asia/Tashkent')::date)
on conflict (user_id, ref_key) do nothing;

-- Rebuild running totals from the authoritative ledger (covers new teacher events; idempotent).
insert into public.user_xp (user_id, total_xp, level, updated_at)
select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
from public.xp_events e
group by e.user_id
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

-- ============================================================
-- (3) teacher_xp: read a teacher's XP total + level + XP-to-next-level for the profile surface.
--     Self-or-staff guard (a teacher reads their own; admins read anyone's; bot service-role too).
-- ============================================================
create or replace function public.teacher_xp(uid uuid)
returns table(total_xp int, level int, xp_next_level int)
language sql stable security definer set search_path = public
as $$
  select coalesce(x.total_xp, 0), coalesce(x.level, 1),
         public.xp_threshold_for(coalesce(x.level, 1))
  from (select 1) _
  left join public.user_xp x on x.user_id = uid
  where (auth.uid() is null or auth.uid() = uid
         or public.has_role(auth.uid(), 'admin'::app_role)
         or public.has_role(auth.uid(), 'superadmin'::app_role));
$$;
grant execute on function public.teacher_xp(uuid) to authenticated;
