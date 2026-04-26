-- 1) Last name on profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_name text;

-- 2) Login attempts (for soft lockout)
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email','ip')),
  success boolean NOT NULL DEFAULT false,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key_kind_time
  ON public.login_attempts (kind, lower(key), created_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- Admins can read; nobody (other than service role) can write directly
DROP POLICY IF EXISTS "login_attempts admin read" ON public.login_attempts;
CREATE POLICY "login_attempts admin read"
  ON public.login_attempts FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- 3) Admin actions audit log
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_user_id uuid,
  target_resource_type text,
  target_resource_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at
  ON public.admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_actor_time
  ON public.admin_actions (actor_user_id, created_at DESC);

ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_actions admin read" ON public.admin_actions;
CREATE POLICY "admin_actions admin read"
  ON public.admin_actions FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));