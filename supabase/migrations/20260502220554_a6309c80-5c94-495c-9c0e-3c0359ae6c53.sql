-- Add teacher to app_role enum (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'public.app_role'::regtype AND enumlabel = 'teacher') THEN
    ALTER TYPE public.app_role ADD VALUE 'teacher';
  END IF;
END $$;

-- Groups table
CREATE TABLE IF NOT EXISTS public.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  course_id uuid REFERENCES public.courses(id) ON DELETE SET NULL,
  teacher_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS groups_name_unique ON public.groups (lower(name));
CREATE INDEX IF NOT EXISTS groups_teacher_id_idx ON public.groups (teacher_id);
CREATE INDEX IF NOT EXISTS groups_course_id_idx ON public.groups (course_id);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups admin all" ON public.groups;
CREATE POLICY "groups admin all" ON public.groups
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER groups_set_updated_at
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add group_id to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_group_id_idx ON public.profiles (group_id);