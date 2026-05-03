
ALTER VIEW public.vw_module_homework_score SET (security_invoker = true);

REVOKE EXECUTE ON FUNCTION public.get_setting(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_settings(text[]) FROM anon;
