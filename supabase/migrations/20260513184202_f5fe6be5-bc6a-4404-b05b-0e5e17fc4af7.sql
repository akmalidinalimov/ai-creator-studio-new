ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS score_is_stale boolean NOT NULL DEFAULT false;