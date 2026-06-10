-- 1. Backfill: every SAP inherits its parent's module_id + task_number.

UPDATE public.homework_assignments AS child
SET module_id = parent.module_id,
    task_number = parent.task_number
FROM public.homework_assignments AS parent
WHERE child.parent_id = parent.id
  AND (child.module_id IS DISTINCT FROM parent.module_id
       OR child.task_number IS DISTINCT FROM parent.task_number);

-- 2. Enforce it going forward (a SAP can never drift from its parent's module/task).

CREATE OR REPLACE FUNCTION public.enforce_sap_inherits_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT module_id, task_number INTO p FROM public.homework_assignments WHERE id = NEW.parent_id;
    IF FOUND THEN
      NEW.module_id := p.module_id;
      NEW.task_number := p.task_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sap_inherits_parent ON public.homework_assignments;
CREATE TRIGGER trg_sap_inherits_parent
  BEFORE INSERT OR UPDATE ON public.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sap_inherits_parent();