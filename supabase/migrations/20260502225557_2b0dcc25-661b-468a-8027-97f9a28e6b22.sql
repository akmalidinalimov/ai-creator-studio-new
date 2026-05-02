CREATE TABLE IF NOT EXISTS public.bot_sessions (
  user_id uuid PRIMARY KEY,
  state text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bot_sessions admin" ON public.bot_sessions;
CREATE POLICY "bot_sessions admin" ON public.bot_sessions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role));

CREATE TABLE IF NOT EXISTS public.bot_broadcast_rate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  recipient_user_id uuid,
  scope text NOT NULL, -- 'teacher' | 'recipient'
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bot_broadcast_rate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bot_broadcast_rate admin" ON public.bot_broadcast_rate;
CREATE POLICY "bot_broadcast_rate admin" ON public.bot_broadcast_rate FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role));
CREATE INDEX IF NOT EXISTS bot_bcast_actor_idx ON public.bot_broadcast_rate (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_bcast_recipient_idx ON public.bot_broadcast_rate (recipient_user_id, created_at DESC);