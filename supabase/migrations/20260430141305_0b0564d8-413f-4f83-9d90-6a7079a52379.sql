-- Enforce uniqueness of telegram_id on profiles to prevent two students sharing one Telegram account.
-- Allows multiple NULL values (default Postgres unique semantics).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_telegram_id_unique
  ON public.profiles (telegram_id)
  WHERE telegram_id IS NOT NULL;