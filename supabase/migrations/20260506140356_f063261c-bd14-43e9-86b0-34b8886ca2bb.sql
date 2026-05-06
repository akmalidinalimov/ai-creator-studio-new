DROP INDEX IF EXISTS public.homework_assignments_module_task_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_module_task_parent_uniq
  ON public.homework_assignments(module_id, task_number)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_parent_sap_uniq
  ON public.homework_assignments(parent_id, sap_number)
  WHERE parent_id IS NOT NULL;