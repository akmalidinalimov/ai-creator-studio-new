
CREATE OR REPLACE FUNCTION public.weekly_digest_status()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT COALESCE((SELECT active FROM cron.job WHERE jobname='weekly_digest'), false);
$$;

CREATE OR REPLACE FUNCTION public.weekly_digest_set_enabled(_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE jid bigint;
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'weekly_digest';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := jid, active := _enabled);
  END IF;
  RETURN _enabled;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.weekly_digest_set_enabled(boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.weekly_digest_status() FROM anon;
