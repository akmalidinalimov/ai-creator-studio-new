
-- A1: group_module_topics
CREATE TABLE public.group_module_topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  telegram_topic_url text NOT NULL,
  telegram_topic_id int,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, module_id)
);

CREATE INDEX idx_gmt_group ON public.group_module_topics(group_id);
CREATE INDEX idx_gmt_module ON public.group_module_topics(module_id);

-- A2: groups telegram url
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS telegram_group_url text;

-- Trigger to parse topic id from URL
CREATE OR REPLACE FUNCTION public.gmt_parse_topic_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  m text[];
BEGIN
  -- match trailing /<digits> at end of URL
  m := regexp_match(NEW.telegram_topic_url, '/(\d+)/?$');
  IF m IS NOT NULL THEN
    NEW.telegram_topic_id := m[1]::int;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gmt_parse_topic_id
BEFORE INSERT OR UPDATE ON public.group_module_topics
FOR EACH ROW EXECUTE FUNCTION public.gmt_parse_topic_id();

-- A3: RLS
ALTER TABLE public.group_module_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gmt admin all"
ON public.group_module_topics
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "gmt teacher read own groups"
ON public.group_module_topics
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'teacher'::app_role)
  AND EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_module_topics.group_id AND g.teacher_id = auth.uid())
);

CREATE POLICY "gmt student read own group"
ON public.group_module_topics
FOR SELECT
TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.group_id = group_module_topics.group_id)
);
