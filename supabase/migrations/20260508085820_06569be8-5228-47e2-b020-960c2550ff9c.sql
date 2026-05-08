-- Drop the certificates table (entirely removed per user request)
DROP TABLE IF EXISTS public.certificates CASCADE;

-- Create module_celebrations table for per-module shareable rewards
CREATE TABLE public.module_celebrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  module_id uuid NOT NULL,
  image_url text,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  UNIQUE (user_id, module_id)
);

ALTER TABLE public.module_celebrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mc own select"
ON public.module_celebrations FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "mc own update"
ON public.module_celebrations FOR UPDATE
TO authenticated
USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "mc admin all"
ON public.module_celebrations FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX idx_module_celebrations_user ON public.module_celebrations(user_id, seen_at);

-- Public storage bucket for shareable module images
INSERT INTO storage.buckets (id, name, public) VALUES ('module-shares', 'module-shares', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "module-shares public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'module-shares');