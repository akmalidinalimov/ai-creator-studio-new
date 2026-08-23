-- Heal false lesson completions from the watch-gate bug (forward-fix shipped in PR #105).
--
-- BUG: watchedEnough() treated an UNKNOWN video duration as "watched enough". Bunny reports no
-- duration until the video is actually PLAYED, so clicking "Next" / "Mark complete" on an un-played
-- video marked it watched. ~18% of video completions had ~0 watch time, inflating completion stats,
-- student XP, AND (via full-module celebrations) teacher_impact XP.
--
-- THIS MIGRATION reverts ONLY provably-unwatched completions — real Bunny video lessons where the
-- student watched LESS THAN 20% of a KNOWN length (>= 90s). Lessons a student later watched (max
-- position now high) are NOT touched; text/homework lessons are NOT touched. It then fans out to the
-- downstream damage: modules that only "completed" because of those false lessons had a celebration
-- row inserted, which paid the group's TEACHER +25 teacher_impact XP — those are reverted too, and
-- the stale celebration row is removed so a genuine future completion can re-fire correctly.
--
-- Safety (verified against live triggers/reconcilers + two specialist reviews):
--  * lesson_progress_guard() BLOCKS clearing completed_at; we disable the table's USER triggers for
--    the surgery. The lock is taken FIRST (before the snapshot) so no concurrent writer can change a
--    row between snapshot and mutate (TOCTOU-safe). lock_timeout fails fast instead of queueing on a
--    hot table. The whole file is ONE implicit transaction (the deploy pipeline POSTs it as a single
--    query), so any failure rolls back — including the trigger disable.
--  * reconcile_lesson_completions() only RE-completes at >= 85% watched, and reconcile_all_xp()
--    re-derives lesson XP only from completed_at IS NOT NULL — neither can resurrect a <20% revert.
--    teacher_impact has NO reconciler leg, so deleting those events is final.
--  * trg_xp_student_module_impact is AFTER INSERT only, so deleting celebration rows fires nothing.
--  * Idempotent (deploy-concurrency-safe): a re-run finds nothing still matching (completed_at now
--    null) → every step is a no-op.
--  * Fully audited + reversible via watch_gate_cleanup_log (RLS: admin-read only via the app;
--    service_role/SQL bypasses; anon/authenticated locked out).

create table if not exists public.watch_gate_cleanup_log (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,            -- 'lesson_revert' | 'teacher_impact_revert'
  user_id              uuid not null,            -- student (lesson_revert) or teacher (teacher_impact_revert)
  ref_id               uuid not null,            -- lesson_id (lesson_revert) or module_id (teacher_impact_revert)
  course_id            uuid,
  prev_completed_at    timestamptz,
  max_position_seconds numeric,
  duration_seconds     numeric,
  amount               int,                      -- XP removed by this revert (negative)
  batch                text not null default 'watch-gate-2026-08-23',
  reverted_at          timestamptz not null default now()
);
alter table public.watch_gate_cleanup_log enable row level security;
-- Admins may read the healing trail (mirrors public.progress_audit); anon/authenticated get nothing,
-- service_role/SQL bypasses RLS.
drop policy if exists "watch_gate_cleanup_log admin read" on public.watch_gate_cleanup_log;
create policy "watch_gate_cleanup_log admin read" on public.watch_gate_cleanup_log
  for select using (public.has_role(auth.uid(), 'admin'));

do $$
declare _rows int; _users int; _tmod int; _timpact int;
begin
  -- Fail fast rather than queue behind an existing lock on this hot table.
  set local lock_timeout = '3s';

  -- Take the lock FIRST (ACCESS EXCLUSIVE via DISABLE TRIGGER) so the snapshot below is consistent
  -- with what we mutate. Also suppresses the guard (which would revert the null) and the AFTER
  -- triggers (streak/badges/nudge/re-activation) that would otherwise churn.
  alter table public.lesson_progress disable trigger user;

  -- 1. Snapshot the provably-unwatched completions (under the lock).
  create temp table _false on commit drop as
  select lp.id as progress_id, lp.user_id, lp.lesson_id, l.module_id, m.course_id,
         lp.completed_at as prev_completed_at,
         coalesce(lp.max_position_seconds, 0) as maxpos,
         greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0)) as dur
  from public.lesson_progress lp
  join public.lessons l on l.id = lp.lesson_id
  join public.modules m on m.id = l.module_id
  where lp.completed_at is not null
    and l.video_provider = 'bunny'
    and coalesce(l.provider_video_id, '') <> ''                       -- a real video (excludes text/homework)
    and greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0)) >= 90
    and coalesce(lp.max_position_seconds, 0)
        < 0.2 * greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0));

  select count(*), count(distinct user_id) into _rows, _users from _false;

  insert into public.watch_gate_cleanup_log (kind, user_id, ref_id, course_id, prev_completed_at, max_position_seconds, duration_seconds, amount)
  select 'lesson_revert', user_id, lesson_id, course_id, prev_completed_at, maxpos, dur, -20 from _false;

  -- 2. Un-complete (keep the watch position so the student resumes where they were).
  update public.lesson_progress lp
  set completed_at = null
  from _false f
  where lp.id = f.progress_id;

  -- 3. Remove the +20 XP each reverted completion awarded (exact ref-key match).
  delete from public.xp_events e
  using _false f
  where e.user_id = f.user_id
    and e.reason = 'lesson_complete'
    and e.ref_key = 'lesson:' || f.lesson_id::text;

  -- 4. Fan-out: modules that are NO LONGER fully complete after the revert but still carry a
  --    celebration row (computed post-null, so it reflects true completion state).
  create temp table _stale_mod on commit drop as
  select distinct f.user_id, f.module_id
  from _false f
  where exists (select 1 from public.nudge_module_celebrations n
                where n.profile_id = f.user_id and n.module_id = f.module_id)
    and (select count(*) from public.lessons l where l.module_id = f.module_id and l.published)
        > (select count(*) from public.lesson_progress lp2
             join public.lessons l2 on l2.id = lp2.lesson_id
            where l2.module_id = f.module_id and l2.published
              and lp2.user_id = f.user_id and lp2.completed_at is not null);
  select count(*) into _tmod from _stale_mod;

  -- 4a. The teacher_impact events those stale celebrations paid (ref_key timpact:mod:<student>:<module>).
  create temp table _timpact on commit drop as
  select e.id as event_id, e.user_id as teacher_id, sm.user_id as student_id, sm.module_id, e.amount
  from _stale_mod sm
  join public.xp_events e
    on e.reason = 'teacher_impact'
   and e.ref_key = 'timpact:mod:' || sm.user_id::text || ':' || sm.module_id::text;
  select count(*) into _timpact from _timpact;

  insert into public.watch_gate_cleanup_log (kind, user_id, ref_id, amount)
  select 'teacher_impact_revert', teacher_id, module_id, -amount from _timpact;

  -- 4b. Remove the false teacher_impact XP.
  delete from public.xp_events e using _timpact t where e.id = t.event_id;

  -- 4c. Remove the stale celebration rows (AFTER INSERT trigger only → delete is inert) so a genuine
  --     future module completion re-celebrates and re-awards the teacher correctly.
  delete from public.nudge_module_celebrations n
  using _stale_mod sm
  where n.profile_id = sm.user_id and n.module_id = sm.module_id;

  alter table public.lesson_progress enable trigger user;

  -- 5. Rebuild totals for every affected user — reverted STUDENTS + affected TEACHERS — from their
  --    full remaining ledger (mirrors reconcile_all_xp; never touches unaffected users).
  insert into public.user_xp (user_id, total_xp, level, updated_at)
  select d.user_id, coalesce(sum(e.amount), 0)::int,
         public.xp_level_for(coalesce(sum(e.amount), 0)::int), now()
  from (select user_id from _false union select teacher_id from _timpact) d
  left join public.xp_events e on e.user_id = d.user_id
  group by d.user_id
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  raise notice 'watch-gate cleanup: reverted % student completions (% students); % stale module-celebrations, % teacher_impact events removed',
    _rows, _users, _tmod, _timpact;
end $$;
