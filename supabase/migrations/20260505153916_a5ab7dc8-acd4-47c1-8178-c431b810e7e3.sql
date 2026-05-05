-- v3.14.7: backfill mangled "tg-..." display names from telegram_username
UPDATE public.profiles
SET name = INITCAP(REPLACE(REPLACE(telegram_username::text, '@', ''), '_', ' '))
WHERE name LIKE 'tg-%'
  AND telegram_username IS NOT NULL
  AND telegram_username::text NOT LIKE 'tg-anon-%';

-- For tg-anon-* rows (no username, only telegram_id), give a neutral placeholder
UPDATE public.profiles
SET name = 'Talaba'
WHERE name LIKE 'tg-anon-%';