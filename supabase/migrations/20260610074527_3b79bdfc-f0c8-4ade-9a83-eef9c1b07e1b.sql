ALTER TABLE public.nudge_log DROP CONSTRAINT IF EXISTS nudge_log_nudge_type_check;

ALTER TABLE public.nudge_log ADD CONSTRAINT nudge_log_nudge_type_check
  CHECK (nudge_type = ANY (ARRAY['inactive_3d','inactive_7d','stuck_lesson','module_complete','student_of_week']));