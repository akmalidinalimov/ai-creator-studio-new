ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_onboarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS preferred_locale text NOT NULL DEFAULT 'uz';

CREATE INDEX IF NOT EXISTS idx_profiles_telegram_username_lower
  ON public.profiles ((lower(telegram_username::text)));

CREATE TABLE IF NOT EXISTS public.telegram_login_tokens (
  token text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authenticated','expired')),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  authenticated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_telegram_login_tokens_status_expires
  ON public.telegram_login_tokens (status, expires_at);

ALTER TABLE public.telegram_login_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.telegram_magic_links (
  token text PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login','deeplink_lesson','deeplink_course')),
  target_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_telegram_magic_links_user
  ON public.telegram_magic_links (user_id);

ALTER TABLE public.telegram_magic_links ENABLE ROW LEVEL SECURITY;