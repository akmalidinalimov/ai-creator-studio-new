-- Voice feedback on grading (2026-07-16, owner request).
-- Teachers could only leave TEXT feedback; sometimes an oral explanation is clearer. When a
-- teacher sends a Telegram VOICE message at the "comment" step, we store its Telegram file_id
-- and re-send it to the student via sendVoice. file_id is the robust path: the audio stays on
-- Telegram's servers, so re-delivery needs no download/upload/storage and lands every time.
alter table public.homework_submissions
  add column if not exists score_feedback_voice_file_id text;
