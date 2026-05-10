ALTER TABLE public.telegram_magic_links
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');