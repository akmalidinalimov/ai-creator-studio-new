ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS name_confirmed_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS name_prompt_last_at timestamptz;