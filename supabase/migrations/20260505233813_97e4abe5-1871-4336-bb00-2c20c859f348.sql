ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_teacher_group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_active_teacher_group_id_idx
  ON public.profiles(active_teacher_group_id);