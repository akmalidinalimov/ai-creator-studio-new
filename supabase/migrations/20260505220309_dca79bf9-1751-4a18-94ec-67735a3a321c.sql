-- v3.14.18: queue table for teacher homework submission DMs
CREATE TABLE IF NOT EXISTS public.homework_teacher_dm_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  student_id uuid NOT NULL,
  group_id uuid NOT NULL,
  module_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  module_number int NOT NULL,
  task_number int NOT NULL,
  assignment_title text,
  student_name text,
  message_url text NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  queued_for_quiet_hours boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_htdq_pending ON public.homework_teacher_dm_queue (scheduled_for) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_htdq_throttle ON public.homework_teacher_dm_queue (student_id, assignment_id, created_at);

ALTER TABLE public.homework_teacher_dm_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "htdq admin read" ON public.homework_teacher_dm_queue
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
