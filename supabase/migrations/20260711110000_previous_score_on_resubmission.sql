-- Previous-grade memory for resubmissions (2026-07-11).
-- A resubmission resets score to NULL for regrading — and until now the old grade vanished with
-- it: the student saw no "you had X/Y" and the teacher regraded without context. previous_score
-- is stamped at resubmission time (picker + auto capture paths) and surfaced in the student's
-- in-thread receipt and the teacher's grading screen.
alter table public.homework_submissions
  add column if not exists previous_score smallint;
