-- AI chat errors log
CREATE TABLE public.ai_chat_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  lesson_id uuid,
  model text,
  status int,
  error_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_chat_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_chat_errors admin read" ON public.ai_chat_errors
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Profile language
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferred_language text DEFAULT 'en';

-- Course AI overrides
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS ai_system_prompt text;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS ai_knowledge_paths text[] DEFAULT '{}'::text[];

-- AI knowledge bucket (private)
INSERT INTO storage.buckets (id, name, public) VALUES ('ai-knowledge', 'ai-knowledge', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "ai-knowledge admin read" ON storage.objects
  FOR SELECT USING (bucket_id = 'ai-knowledge' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "ai-knowledge admin write" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'ai-knowledge' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "ai-knowledge admin update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'ai-knowledge' AND public.has_role(auth.uid(), 'admin'));
CREATE POLICY "ai-knowledge admin delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'ai-knowledge' AND public.has_role(auth.uid(), 'admin'));

-- Extend get_public_setting to expose content_protection toggles (non-secret)
CREATE OR REPLACE FUNCTION public.get_public_setting(_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  result jsonb := '{}'::jsonb;
BEGIN
  SELECT value INTO v FROM public.platform_settings WHERE key = _key;

  IF _key = 'telegram' THEN
    IF v IS NULL THEN RETURN result; END IF;
    result := jsonb_build_object('bot_username', COALESCE(v->>'bot_username', ''));
  ELSIF _key = 'content_protection' THEN
    -- Defaults: everything ON
    result := jsonb_build_object(
      'watermark', COALESCE((v->>'watermark')::boolean, true),
      'no_right_click', COALESCE((v->>'no_right_click')::boolean, true),
      'pause_on_blur', COALESCE((v->>'pause_on_blur')::boolean, true),
      'devtools_detect', COALESCE((v->>'devtools_detect')::boolean, true),
      'hardened_controls', COALESCE((v->>'hardened_controls')::boolean, true)
    );
  END IF;

  RETURN result;
END;
$function$;