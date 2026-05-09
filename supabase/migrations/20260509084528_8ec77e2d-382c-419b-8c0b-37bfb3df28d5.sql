-- 1) Audit table
CREATE TABLE IF NOT EXISTS public.progress_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  op text NOT NULL,
  user_id uuid,
  row_id uuid,
  before jsonb,
  after jsonb,
  db_user text NOT NULL DEFAULT current_user,
  changed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.progress_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "progress_audit admin read"
  ON public.progress_audit FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_progress_audit_user ON public.progress_audit (user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_audit_changed_at ON public.progress_audit (changed_at DESC);

-- 2) Guard for lesson_progress: never clear completed_at, log destructive ops
CREATE OR REPLACE FUNCTION public.lesson_progress_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL THEN
      INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after)
      VALUES ('lesson_progress', 'BLOCKED_CLEAR_COMPLETED', OLD.user_id, OLD.id, to_jsonb(OLD), to_jsonb(NEW));
      NEW.completed_at := OLD.completed_at;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after)
    VALUES ('lesson_progress', 'DELETE', OLD.user_id, OLD.id, to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lesson_progress_guard_upd ON public.lesson_progress;
CREATE TRIGGER lesson_progress_guard_upd
  BEFORE UPDATE ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.lesson_progress_guard();

DROP TRIGGER IF EXISTS lesson_progress_guard_del ON public.lesson_progress;
CREATE TRIGGER lesson_progress_guard_del
  BEFORE DELETE ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.lesson_progress_guard();

-- 3) Guard for homework_submissions: never clear a non-null score, log destructive ops
CREATE OR REPLACE FUNCTION public.homework_submissions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.score IS NOT NULL AND NEW.score IS NULL THEN
      INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after)
      VALUES ('homework_submissions', 'BLOCKED_CLEAR_SCORE', OLD.user_id, OLD.id, to_jsonb(OLD), to_jsonb(NEW));
      NEW.score := OLD.score;
      NEW.scored_at := COALESCE(NEW.scored_at, OLD.scored_at);
      NEW.scored_by := COALESCE(NEW.scored_by, OLD.scored_by);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after)
    VALUES ('homework_submissions', 'DELETE', OLD.user_id, OLD.id, to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS homework_submissions_guard_upd ON public.homework_submissions;
CREATE TRIGGER homework_submissions_guard_upd
  BEFORE UPDATE ON public.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION public.homework_submissions_guard();

DROP TRIGGER IF EXISTS homework_submissions_guard_del ON public.homework_submissions;
CREATE TRIGGER homework_submissions_guard_del
  BEFORE DELETE ON public.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION public.homework_submissions_guard();