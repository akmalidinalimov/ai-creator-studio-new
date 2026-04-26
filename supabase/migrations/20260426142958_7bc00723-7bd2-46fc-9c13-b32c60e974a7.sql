-- Remove public read on platform_settings — it leaked the Telegram bot_token.
DROP POLICY IF EXISTS "platform_settings public read" ON public.platform_settings;

-- Admin-only SELECT
CREATE POLICY "platform_settings admin select"
ON public.platform_settings
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Safe public accessor: returns only whitelisted, non-secret fields per key.
CREATE OR REPLACE FUNCTION public.get_public_setting(_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
  result jsonb := '{}'::jsonb;
BEGIN
  SELECT value INTO v FROM public.platform_settings WHERE key = _key;
  IF v IS NULL THEN
    RETURN result;
  END IF;

  -- Whitelist per key. NEVER expose tokens / secrets here.
  IF _key = 'telegram' THEN
    result := jsonb_build_object(
      'bot_username', COALESCE(v->>'bot_username', '')
    );
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_setting(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_setting(text) TO anon, authenticated;