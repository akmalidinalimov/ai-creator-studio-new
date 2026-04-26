
-- Metrics table for study-assistant requests
CREATE TABLE public.ai_chat_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  lesson_id uuid,
  model text,                   -- final model used (or last attempted on failure)
  attempts integer NOT NULL DEFAULT 1, -- total upstream attempts including retries/fallbacks
  fallback_used boolean NOT NULL DEFAULT false, -- true if not the primary model
  success boolean NOT NULL DEFAULT true,
  status integer,               -- final HTTP status from upstream (0 if internal)
  latency_ms integer NOT NULL DEFAULT 0,
  language text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_chat_metrics_created_at ON public.ai_chat_metrics(created_at DESC);
CREATE INDEX idx_ai_chat_metrics_model ON public.ai_chat_metrics(model);

ALTER TABLE public.ai_chat_metrics ENABLE ROW LEVEL SECURITY;

-- Only admins can read metrics; inserts happen via service role (bypasses RLS), so no insert policy needed.
CREATE POLICY "ai_chat_metrics admin read"
  ON public.ai_chat_metrics
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
