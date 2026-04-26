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
    result := jsonb_build_object(
      'bot_username', COALESCE(v->>'bot_username', ''),
      'bot_id', COALESCE(split_part(v->>'bot_token', ':', 1), '')
    );
  ELSIF _key = 'content_protection' THEN
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