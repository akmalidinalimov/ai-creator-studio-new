-- v3.15: Bot-first homework submission

-- 1. Add Telegram-source columns to homework_submissions
ALTER TABLE public.homework_submissions
  ADD COLUMN IF NOT EXISTS telegram_chat_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_thread_id integer,
  ADD COLUMN IF NOT EXISTS telegram_message_id integer,
  ADD COLUMN IF NOT EXISTS telegram_message_url text,
  ADD COLUMN IF NOT EXISTS telegram_file_id text,
  ADD COLUMN IF NOT EXISTS telegram_file_kind text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hw_user_assignment
  ON public.homework_submissions(user_id, assignment_id);

CREATE INDEX IF NOT EXISTS ix_hw_tg_msg
  ON public.homework_submissions(telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

-- 2. New table: bot_homework_intents (short-lived "I'm about to post" markers)
CREATE TABLE IF NOT EXISTS public.bot_homework_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  module_id uuid NOT NULL,
  group_id uuid,
  telegram_chat_id bigint NOT NULL,
  telegram_thread_id integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, assignment_id)
);

CREATE INDEX IF NOT EXISTS ix_bhi_chat_thread
  ON public.bot_homework_intents(telegram_chat_id, telegram_thread_id, expires_at);

ALTER TABLE public.bot_homework_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bhi admin all"
  ON public.bot_homework_intents
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
