
ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS attempt_number int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_attempts jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Replace guard trigger to allow legitimate resubmissions
CREATE OR REPLACE FUNCTION public.homework_submissions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after, db_user)
      VALUES ('homework_submissions', 'DELETE', OLD.user_id, OLD.id, to_jsonb(OLD), NULL, current_user);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Allow score clearing only when attempt_number increases (resubmission)
    IF OLD.score IS NOT NULL AND NEW.score IS NULL THEN
      IF COALESCE(NEW.attempt_number, 1) > COALESCE(OLD.attempt_number, 1) THEN
        -- legitimate resubmission, allow
        RETURN NEW;
      ELSE
        BEGIN
          INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after, db_user)
          VALUES ('homework_submissions', 'BLOCKED_CLEAR_SCORE', OLD.user_id, OLD.id, to_jsonb(OLD), to_jsonb(NEW), current_user);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        NEW.score := OLD.score;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- Resubmission RPC
CREATE OR REPLACE FUNCTION public.start_homework_resubmission(p_submission_id uuid)
RETURNS public.homework_submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.homework_submissions;
  v_caller uuid := auth.uid();
  v_snapshot jsonb;
BEGIN
  SELECT * INTO v_row FROM public.homework_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_not_found';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF v_caller <> v_row.user_id
     AND NOT public.has_role(v_caller, 'teacher'::app_role)
     AND NOT public.has_role(v_caller, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_row.score IS NULL THEN
    -- nothing to archive; still bump attempt to keep semantics
    RETURN v_row;
  END IF;

  v_snapshot := jsonb_build_object(
    'attempt_number', v_row.attempt_number,
    'score', v_row.score,
    'score_feedback', v_row.score_feedback,
    'scored_by', v_row.scored_by,
    'scored_at', v_row.scored_at,
    'submitted_at', v_row.submitted_at,
    'telegram_message_url', v_row.telegram_message_url,
    'is_late', v_row.is_late
  );

  UPDATE public.homework_submissions
     SET attempt_number = COALESCE(attempt_number, 1) + 1,
         previous_attempts = COALESCE(previous_attempts, '[]'::jsonb) || v_snapshot,
         score = NULL,
         score_feedback = NULL,
         scored_by = NULL,
         scored_at = NULL,
         is_late = false,
         submitted_at = now(),
         updated_at = now()
   WHERE id = p_submission_id
   RETURNING * INTO v_row;

  BEGIN
    INSERT INTO public.progress_audit (table_name, op, user_id, row_id, before, after, db_user)
    VALUES ('homework_submissions', 'RESUBMIT', v_row.user_id, v_row.id, v_snapshot, to_jsonb(v_row), current_user);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_homework_resubmission(uuid) TO authenticated;
