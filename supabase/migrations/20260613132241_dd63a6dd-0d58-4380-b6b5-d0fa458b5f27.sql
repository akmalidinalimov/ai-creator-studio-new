ALTER TABLE public.homework_ungraded_reminders ADD COLUMN IF NOT EXISTS cycle_submitted_at timestamptz;

UPDATE public.homework_ungraded_reminders r
SET cycle_submitted_at = hs.submitted_at
FROM public.homework_submissions hs
WHERE hs.id = r.submission_id AND r.cycle_submitted_at IS NULL;