-- Multi-media homework: up to 10 photos/videos/PDFs/links per submission.
-- media = jsonb array of {kind: photo|video|document|link, file_id?, url?, msg_url}.
-- The intent row now carries submission_id so follow-up posts (albums, extra
-- files) APPEND to the same submission instead of being dropped.

alter table public.homework_submissions
  add column if not exists media jsonb not null default '[]'::jsonb;

alter table public.bot_homework_intents
  add column if not exists submission_id uuid;

-- Backfill: lift the legacy single-file columns into the media array.
update public.homework_submissions
set media = jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
  'kind', telegram_file_kind,
  'file_id', telegram_file_id,
  'msg_url', telegram_message_url)))
where media = '[]'::jsonb
  and telegram_file_id is not null and telegram_file_kind is not null;
