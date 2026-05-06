ALTER TABLE public.homework_assignments
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sap_number integer;

ALTER TABLE public.homework_assignments DROP CONSTRAINT IF EXISTS homework_assignments_module_task_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_module_task_parent_uniq
  ON public.homework_assignments(module_id, task_number)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_parent_sap_uniq
  ON public.homework_assignments(parent_id, sap_number)
  WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS homework_assignments_parent_id_idx
  ON public.homework_assignments(parent_id);

DROP VIEW IF EXISTS public.vw_module_homework_score;

CREATE VIEW public.vw_module_homework_score
WITH (security_invoker = true) AS
WITH leaves AS (
  SELECT ha.*
  FROM public.homework_assignments ha
  WHERE NOT EXISTS (
    SELECT 1 FROM public.homework_assignments c WHERE c.parent_id = ha.id
  )
)
SELECT
  hs.user_id AS profile_id,
  l.module_id,
  count(*) FILTER (WHERE hs.score IS NOT NULL) AS scored_tasks,
  count(*) AS total_submitted_tasks,
  (SELECT count(*) FROM leaves l2 WHERE l2.module_id = l.module_id AND l2.is_active = true) AS total_active_tasks_in_module,
  COALESCE(sum(hs.score) FILTER (WHERE hs.score IS NOT NULL), 0)::numeric AS module_total,
  COALESCE(sum(CASE WHEN hs.score IS NOT NULL THEN l.max_score END), 0)::numeric AS module_max,
  CASE
    WHEN COALESCE(sum(CASE WHEN hs.score IS NOT NULL THEN l.max_score END), 0) > 0
    THEN round(
      (sum(hs.score) FILTER (WHERE hs.score IS NOT NULL))::numeric
      / (sum(CASE WHEN hs.score IS NOT NULL THEN l.max_score END))::numeric
      * 10, 1)
    ELSE NULL
  END AS avg_score_normalized
FROM public.homework_submissions hs
JOIN leaves l ON l.id = hs.assignment_id
GROUP BY hs.user_id, l.module_id;