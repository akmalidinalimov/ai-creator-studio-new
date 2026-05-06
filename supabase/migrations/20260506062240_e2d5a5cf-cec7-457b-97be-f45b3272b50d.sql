CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_telegram_username_lower
ON public.profiles (lower(replace(coalesce(telegram_username::text, ''), '@', '')))
WHERE telegram_username IS NOT NULL AND length(telegram_username::text) > 0;