-- RESTORE AI CREATORS 4.0 student data from the archive taken by the purge migration
-- (20260818140000_purge_ai_creators_4_0_student_data.sql).
--
-- This is a MANUAL recovery tool — run it in the Supabase SQL editor ONLY if you need to undo the
-- purge. It is NOT a migration (never auto-applied). It re-inserts every archived row and rebuilds
-- user_xp. Idempotent: `on conflict do nothing` skips rows that already exist, so it's safe to run
-- more than once and safe to run even if only some rows were re-created in the meantime.
--
-- Precondition: schema `archive_40` still exists (i.e. you have NOT yet dropped it). If it's gone,
-- the data is unrecoverable by this script.

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'archive_40') then
    raise exception 'archive_40 does not exist — nothing to restore (was it already dropped?).';
  end if;
end $$;

-- Parent BEFORE child (homework_ungraded_reminders has an FK to homework_submissions).
insert into public.homework_submissions       select * from archive_40.homework_submissions       on conflict do nothing;
insert into public.homework_ungraded_reminders select * from archive_40.homework_ungraded_reminders on conflict do nothing;
insert into public.lesson_progress            select * from archive_40.lesson_progress            on conflict do nothing;
insert into public.xp_events                  select * from archive_40.xp_events                  on conflict do nothing;
insert into public.homework_teacher_dm_queue  select * from archive_40.homework_teacher_dm_queue  on conflict do nothing;
insert into public.nudge_module_celebrations  select * from archive_40.nudge_module_celebrations  on conflict do nothing;
insert into public.quiz_attempts              select * from archive_40.quiz_attempts              on conflict do nothing;
insert into public.ai_chat_metrics            select * from archive_40.ai_chat_metrics            on conflict do nothing;
insert into public.bot_homework_intents       select * from archive_40.bot_homework_intents       on conflict do nothing;
insert into public.module_celebrations        select * from archive_40.module_celebrations        on conflict do nothing;
insert into public.ai_chat_messages           select * from archive_40.ai_chat_messages           on conflict do nothing;
insert into public.lesson_notes               select * from archive_40.lesson_notes               on conflict do nothing;

-- Rebuild user_xp for the affected users from the (now-restored) full ledger.
insert into public.user_xp (user_id, total_xp, level, updated_at)
select au.user_id,
       coalesce((select sum(e.amount)::int from public.xp_events e where e.user_id = au.user_id), 0),
       public.xp_level_for(coalesce((select sum(e.amount)::int from public.xp_events e where e.user_id = au.user_id), 0)),
       now()
from archive_40._affected_users au
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

-- Verify: 4.0 data is back (expect the original counts) and totals settle.
select
  (select count(*) from public.homework_submissions hs join public.homework_assignments a on a.id=hs.assignment_id join public.modules m on m.id=a.module_id where m.course_id='c8103dae-f8e5-463a-882f-f52b04b12223') as hw_restored,
  (select count(*) from public.lesson_progress lp join public.lessons l on l.id=lp.lesson_id join public.modules m on m.id=l.module_id where m.course_id='c8103dae-f8e5-463a-882f-f52b04b12223') as lp_restored,
  (select count(*) from public.xp_events e where e.ref_key in (select ref_key from archive_40._refkeys)) as xp_restored;

-- After you've confirmed the restore, you may drop the archive:  drop schema archive_40 cascade;
