UPDATE public.homework_submissions
SET score = NULL,
    score_feedback = NULL,
    scored_by = NULL,
    scored_at = NULL,
    score_is_stale = false,
    attempt_number = COALESCE(attempt_number, 1) + 1,
    updated_at = now()
WHERE id IN (
  'c04e619a-0af8-4b0f-9190-5f031a216276',
  '8d3b60ee-9dff-4c0f-8a78-1b65239bdd59',
  '054ac117-37b8-4cd4-8e60-0e6deb9a1cb4'
);