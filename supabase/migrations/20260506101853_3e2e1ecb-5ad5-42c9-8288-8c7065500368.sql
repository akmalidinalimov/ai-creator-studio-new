
CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  update_type text,
  chat_id bigint,
  chat_type text,
  chat_title text,
  message_thread_id bigint,
  message_id bigint,
  from_user_id bigint,
  from_username text,
  text_preview text,
  raw_update jsonb NOT NULL,
  resolution jsonb
);

CREATE INDEX IF NOT EXISTS webhook_inbox_received_at_idx ON public.webhook_inbox (received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_inbox_chat_id_idx ON public.webhook_inbox (chat_id);
CREATE INDEX IF NOT EXISTS webhook_inbox_from_user_id_idx ON public.webhook_inbox (from_user_id);

ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_inbox admin read"
ON public.webhook_inbox
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));
