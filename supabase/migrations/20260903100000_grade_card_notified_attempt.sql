-- P0 (grade_delivery_watchdog SILENCE alarm, 2026-09-03): Mini App / web grading did NOT notify the
-- student. Only BOT grading DMs a grade card (webhook gradeStudentDM, stamps grade_card_dm_heartbeat),
-- and notify-grade-voice DMd only when a VOICE note existed ("app grades otherwise send no DM today").
-- Teachers moved to Mini App grading → students graded silently (18 in 48h at detection). This column
-- lets notify-grade-voice send the full grade card on every app grade, deduped to ONE DM per graded
-- ATTEMPT: a plain feedback edit (same attempt_number, re-saved scored_at) won't re-spam, while a
-- resubmission bumps attempt_number and correctly re-notifies. NULL = never notified for this row.
alter table public.homework_submissions
  add column if not exists grade_card_notified_attempt integer;

comment on column public.homework_submissions.grade_card_notified_attempt is
  'attempt_number of the last grade-card DM sent to the student (notify-grade-voice). NULL = not yet '
  'notified. Re-send only when NULL or < attempt_number (once per graded attempt, no re-grade spam).';
