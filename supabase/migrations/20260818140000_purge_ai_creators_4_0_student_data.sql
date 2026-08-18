-- Purge AI CREATORS 4.0 STUDENT-GENERATED data (owner-approved 2026-08-18).
--
-- KEEPS (untouched): the 4.0 course row + its content (8 modules / 62 lessons / 7 assignments /
-- quiz questions), the AI knowledge base, all 500 student accounts, and their 4.0 enrollments
-- (so old students can still be targeted for broadcasts). Teacher grading XP (reason
-- 'teacher_grade%') and global daily-active/streak XP are NOT course-scoped and are kept, so
-- teachers keep credit for grading and the ~13 students who moved 4.0->5.0 keep their engagement
-- history — they only lose 4.0 coursework points. Earned badges (user_badges) are permanent and
-- are kept by design.
--
-- DELETES (per-student 4.0 data only): homework submissions (+ their cascade
-- homework_ungraded_reminders, 93 rows), lesson progress, 4.0-content XP events, and related
-- per-student 4.0 records (celebrations, quiz attempts, AI-chat metrics/messages, homework-DM
-- queue, bot intents, notes). Homework images are Telegram-hosted (0 objects in Supabase storage)
-- so there is nothing to purge from storage. (lesson_bookmarks/ratings/comments and hw_pending_posts
-- have 0 rows for 4.0 — verified — so they are intentionally not touched.)
--
-- SAFETY:
--   * Archive-first: every deleted row is copied into schema `archive_40` and is fully restorable.
--     Drop that schema once comfortable.
--   * `lock table ... in share mode` holds for the run so the archive and the delete see ONE
--     consistent snapshot, and concurrent student writes / XP reconciler crons cannot insert a
--     straggler 4.0 row between archive and delete (or resurrect one). `set local lock_timeout`
--     makes acquisition fail fast (clean rollback) instead of queuing live traffic if the lock
--     can't be taken. NOTE: this lock also briefly blocks 5.0 XP/homework/lesson writes for the
--     duration (these tables are cross-course) — MERGE THIS OFF-PEAK (Tashkent night).
--   * Runs as one implicit transaction (the deploy pipeline posts the whole file in a single
--     simple-query call): the closing assertion RAISEs — rolling back EVERYTHING — if any non-4.0
--     (i.e. 5.0) row was affected.
--   * Idempotency guard aborts if `archive_40` already exists, so a double-apply cannot re-run.
--
-- XP CORRECTNESS: reconcile_all_xp()/reconcile_lesson_completions() re-derive lesson/homework XP
-- FROM lesson_progress + homework_submissions, so those source rows are deleted here too (else the
-- reconcilers would recreate the 4.0 events). user_xp is then rebuilt from the REMAINING events for
-- every affected user (-> 0 if none remain). The ~13 movers' total_xp/level/tier drop silently on
-- next view (tiers are computed live off total_xp; no stored state, so no false level/tier DM fires).
--
-- OPS: if the SQL commits but the ops_applied_migrations ledger write fails, a retry will hit the
-- `archive_40 already exists` guard and fail the Apply-migrations step — backfill the ledger row
-- manually, do NOT re-run the file. Do NOT re-run this file after dropping archive_40.
--
-- 4.0 course id: c8103dae-f8e5-463a-882f-f52b04b12223

do $guard$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'archive_40') then
    raise exception 'archive_40 already exists — 4.0 purge appears to have already been applied; aborting to avoid a re-run.';
  end if;
end $guard$;

create schema archive_40;

-- Fail fast (clean rollback) instead of queuing live traffic if the lock can't be acquired.
set local lock_timeout = '5s';

-- Block concurrent writers/reconcilers for the duration so archive == delete (one snapshot).
lock table
  public.homework_submissions, public.homework_ungraded_reminders, public.lesson_progress,
  public.xp_events, public.homework_teacher_dm_queue, public.nudge_module_celebrations,
  public.quiz_attempts, public.ai_chat_metrics, public.bot_homework_intents,
  public.module_celebrations, public.ai_chat_messages, public.lesson_notes, public.user_xp
  in share mode;

-- Authoritative 4.0 id / ref-key sets (used identically for archive AND delete)
create table archive_40._m4 as select id from public.modules where course_id = 'c8103dae-f8e5-463a-882f-f52b04b12223';
create table archive_40._l4 as select id from public.lessons where module_id in (select id from archive_40._m4);
create table archive_40._a4 as select id from public.homework_assignments where module_id in (select id from archive_40._m4);
-- 4.0 XP event ref_keys, matched by exact string (cast-free — no split_part/::uuid guard-order risk)
create table archive_40._refkeys as
      select 'lesson:'    || id::text as ref_key from archive_40._l4
  union all select 'hw_submit:' || id::text            from archive_40._a4
  union all select 'hw_score:'  || id::text            from archive_40._a4;

-- Baseline non-4.0 counts BEFORE (for the 5.0-safety assertion)
create table archive_40._baseline as
  select
    (select count(*) from public.lesson_progress     where lesson_id     not in (select id from archive_40._l4))      as lp_non40,
    (select count(*) from public.homework_submissions where assignment_id not in (select id from archive_40._a4))      as hw_non40,
    (select count(*) from public.xp_events           where ref_key       not in (select ref_key from archive_40._refkeys)) as xp_non40;

-- ── Archive every row to be deleted (identical predicates to the deletes below) ────
create table archive_40.homework_submissions as
  select * from public.homework_submissions where assignment_id in (select id from archive_40._a4);
create table archive_40.homework_ungraded_reminders as  -- cascade target of homework_submissions delete
  select * from public.homework_ungraded_reminders where submission_id in (select id from archive_40.homework_submissions);
create table archive_40.lesson_progress as
  select * from public.lesson_progress where lesson_id in (select id from archive_40._l4);
create table archive_40.xp_events as
  select * from public.xp_events where ref_key in (select ref_key from archive_40._refkeys);
create table archive_40.homework_teacher_dm_queue as
  select * from public.homework_teacher_dm_queue where assignment_id in (select id from archive_40._a4) or module_id in (select id from archive_40._m4);
create table archive_40.nudge_module_celebrations as
  select * from public.nudge_module_celebrations where module_id in (select id from archive_40._m4);
create table archive_40.quiz_attempts as
  select * from public.quiz_attempts where module_id in (select id from archive_40._m4);
create table archive_40.ai_chat_metrics as
  select * from public.ai_chat_metrics where lesson_id in (select id from archive_40._l4);
create table archive_40.bot_homework_intents as
  select * from public.bot_homework_intents where assignment_id in (select id from archive_40._a4) or module_id in (select id from archive_40._m4);
create table archive_40.module_celebrations as
  select * from public.module_celebrations where module_id in (select id from archive_40._m4);
create table archive_40.ai_chat_messages as
  select * from public.ai_chat_messages where lesson_id in (select id from archive_40._l4);
create table archive_40.lesson_notes as
  select * from public.lesson_notes where lesson_id in (select id from archive_40._l4);
create table archive_40._affected_users as select distinct user_id from archive_40.xp_events;

-- ── Delete (snapshot-consistent under the SHARE lock) ──────────────────────────────
delete from public.homework_ungraded_reminders where submission_id in (select id from archive_40.homework_submissions);
delete from public.xp_events                where ref_key       in (select ref_key from archive_40._refkeys);
delete from public.lesson_progress          where lesson_id     in (select id from archive_40._l4);
delete from public.homework_submissions     where assignment_id in (select id from archive_40._a4);
delete from public.homework_teacher_dm_queue where assignment_id in (select id from archive_40._a4) or module_id in (select id from archive_40._m4);
delete from public.nudge_module_celebrations where module_id    in (select id from archive_40._m4);
delete from public.quiz_attempts            where module_id     in (select id from archive_40._m4);
delete from public.ai_chat_metrics          where lesson_id     in (select id from archive_40._l4);
delete from public.bot_homework_intents     where assignment_id in (select id from archive_40._a4) or module_id in (select id from archive_40._m4);
delete from public.module_celebrations      where module_id     in (select id from archive_40._m4);
delete from public.ai_chat_messages         where lesson_id     in (select id from archive_40._l4);
delete from public.lesson_notes             where lesson_id     in (select id from archive_40._l4);

-- ── Rebuild user_xp for affected users from REMAINING events (0 if none left) ──────
-- INSERT ... ON CONFLICT (not a bare UPDATE) so a user missing a user_xp row still settles.
insert into public.user_xp (user_id, total_xp, level, updated_at)
select au.user_id,
       coalesce((select sum(e.amount)::int from public.xp_events e where e.user_id = au.user_id), 0),
       public.xp_level_for(coalesce((select sum(e.amount)::int from public.xp_events e where e.user_id = au.user_id), 0)),
       now()
from archive_40._affected_users au
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

-- ── Non-4.0 (5.0) safety assertion — RAISE rolls back the whole migration ──────────
do $assert$
declare b record; lp int; hw int; xp int; l4lp int; l4hw int; l4xp int;
begin
  select * into b from archive_40._baseline;
  select count(*) into lp from public.lesson_progress     where lesson_id     not in (select id from archive_40._l4);
  select count(*) into hw from public.homework_submissions where assignment_id not in (select id from archive_40._a4);
  select count(*) into xp from public.xp_events           where ref_key       not in (select ref_key from archive_40._refkeys);
  if lp <> b.lp_non40 then raise exception '5.0-safety FAILED: non-4.0 lesson_progress % -> %', b.lp_non40, lp; end if;
  if hw <> b.hw_non40 then raise exception '5.0-safety FAILED: non-4.0 homework_submissions % -> %', b.hw_non40, hw; end if;
  if xp <> b.xp_non40 then raise exception '5.0-safety FAILED: non-4.0 xp_events % -> %', b.xp_non40, xp; end if;

  select count(*) into l4lp from public.lesson_progress     where lesson_id     in (select id from archive_40._l4);
  select count(*) into l4hw from public.homework_submissions where assignment_id in (select id from archive_40._a4);
  select count(*) into l4xp from public.xp_events           where ref_key       in (select ref_key from archive_40._refkeys);
  if l4lp <> 0 then raise exception '4.0 lesson_progress not fully deleted (% left)', l4lp; end if;
  if l4hw <> 0 then raise exception '4.0 homework_submissions not fully deleted (% left)', l4hw; end if;
  if l4xp <> 0 then raise exception '4.0 xp_events not fully deleted (% left)', l4xp; end if;

  raise notice '4.0 purge OK: non-4.0 kept lp=% hw=% xp=%; user_xp rebuilt for affected users.', lp, hw, xp;
end $assert$;
