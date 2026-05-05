-- Add 'archived' value to user_status enum
ALTER TYPE public.user_status ADD VALUE IF NOT EXISTS 'archived';

-- Add archived_at timestamp
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Index for filtering
CREATE INDEX IF NOT EXISTS profiles_status_idx ON public.profiles(status);