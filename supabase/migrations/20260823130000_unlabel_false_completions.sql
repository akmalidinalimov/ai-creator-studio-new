-- Un-label false lesson completions from the watch-gate bug — KEEP ALL POINTS.
--
-- Owner directive (supersedes the abandoned #106): do NOT change XP / rating. Only remove the false
-- "watched" checkmark so students can see and re-watch the lessons they didn't actually watch.
-- `lesson_progress.completed_at` is the single source of truth for "watched" (every student surface
-- reads `completed_at IS NOT NULL`; there is no separate boolean), so clearing it removes the checkmark
-- everywhere. We leave every `xp_events` row, `user_xp`, all leaderboards, `nudge_module_celebrations`
-- and all teacher XP untouched — points and rankings do not move.
--
-- Scope: TIER-1 false set only — real Bunny video watched <20% of a KNOWN length (>=90s). ~269 rows.
--
-- Safety:
--  * `lesson_progress_guard()` blocks clearing completed_at, so disable USER triggers for the update
--    (lock-first / lock_timeout / one transaction → rolls back on any failure). Reviewed pattern.
--  * The clear STICKS: `reconcile_lesson_completions()` only re-completes at >=85% watched; <20% is
--    far below. `reconcile_all_xp()` is insert-only and never deletes the kept XP.
--  * Re-watching genuinely re-sets completed_at and, by ref-key idempotency, does NOT double-award →
--    the point total is identical whether or not the student re-watches.
--  * Idempotent (deploy-concurrency-safe): a re-run finds nothing still matching (completed_at now
--    null) → no-op.
--  * Audited + reversible in unlabeled_completions_log (admin-read RLS; also the watchdog's
--    grandfather list so it never alarms on these intentionally-kept awards).

create table if not exists public.unlabeled_completions_log (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  lesson_id            uuid not null,
  course_id            uuid,
  prev_completed_at    timestamptz,
  max_position_seconds numeric,
  duration_seconds     numeric,
  batch                text not null default 'unlabel-watch-gate-2026-08-23',
  cleared_at           timestamptz not null default now()
);
alter table public.unlabeled_completions_log enable row level security;
drop policy if exists "unlabeled_completions_log admin read" on public.unlabeled_completions_log;
create policy "unlabeled_completions_log admin read" on public.unlabeled_completions_log
  for select using (public.has_role(auth.uid(), 'admin'));

do $$
declare _rows int; _users int;
begin
  set local lock_timeout = '3s';
  -- Lock first (ACCESS EXCLUSIVE via DISABLE TRIGGER) so the snapshot is consistent with the mutate,
  -- and so the guard (which reverts a completed_at clear) is suppressed for this surgery.
  alter table public.lesson_progress disable trigger user;

  create temp table _false on commit drop as
  select lp.id as progress_id, lp.user_id, lp.lesson_id, m.course_id, lp.completed_at as prev_completed_at,
         coalesce(lp.max_position_seconds, 0) as maxpos,
         greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0)) as dur
  from public.lesson_progress lp
  join public.lessons l on l.id = lp.lesson_id
  join public.modules m on m.id = l.module_id
  where lp.completed_at is not null
    and l.video_provider = 'bunny'
    and coalesce(l.provider_video_id, '') <> ''
    and greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0)) >= 90
    and coalesce(lp.max_position_seconds, 0)
        < 0.2 * greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0));

  select count(*), count(distinct user_id) into _rows, _users from _false;

  insert into public.unlabeled_completions_log (user_id, lesson_id, course_id, prev_completed_at, max_position_seconds, duration_seconds)
  select user_id, lesson_id, course_id, prev_completed_at, maxpos, dur from _false;

  -- Remove the "watched" checkmark ONLY. Keep the watch position (resume) and ALL XP.
  update public.lesson_progress lp
  set completed_at = null
  from _false f
  where lp.id = f.progress_id;

  alter table public.lesson_progress enable trigger user;

  raise notice 'unlabel watch-gate: cleared % false "watched" labels across % students (points untouched)', _rows, _users;
end $$;
