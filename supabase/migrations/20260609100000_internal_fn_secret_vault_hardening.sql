-- RECONCILIATION MIGRATION — captures the live-only DB changes made during the
-- 2026-06-09 edge-function security hardening (Vault-based internal-secret auth),
-- so the repo matches the live database. ALREADY APPLIED IN PRODUCTION via the
-- Lovable SQL editor. Every statement is idempotent (guarded / CREATE OR REPLACE)
-- and safe on a fresh DB (this migration is ordered AFTER the cron jobs and
-- public.track_video_progress are created by earlier migrations).
--
-- Pairs with edge-function guards deployed via Lovable (already in the repo):
--   * Vault-guarded fns read public.internal_fn_secret() via a service-role admin
--     client and 403 callers whose x-internal-secret header doesn't match:
--       notify-homework-submission, cron-engagement, cron-admin-digest,
--       weekly-admin-topic-check, notify-completion.
--   * generate-module-share-image uses the Deno.env INTERNAL_FN_SECRET (edge->edge).
--   * notify-admin-new-student uses verify_jwt = true (supabase/config.toml).
-- See memory/deploy-mechanism.md.
--
-- Requires the supabase_vault extension (installed on Supabase by default).

-- 1) Vault secret: single source of truth for the internal fn-to-fn auth value.
--    DB-generated (no human handles it); created once.
DO $vault$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'INTERNAL_FN_SECRET') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'INTERNAL_FN_SECRET',
      'Internal function-to-function auth secret (cron/DB callers).'
    );
  END IF;
END
$vault$;

-- 2) Accessor RPC: SECURITY DEFINER, returns the decrypted secret. Locked down so
--    only service_role can read it (an attacker with the anon key cannot).
CREATE OR REPLACE FUNCTION public.internal_fn_secret()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, vault
AS $fn$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'INTERNAL_FN_SECRET'
  ORDER BY created_at DESC
  LIMIT 1;
$fn$;

REVOKE EXECUTE ON FUNCTION public.internal_fn_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_fn_secret() TO service_role;

-- 3) Re-schedule the 4 cron jobs to forward the Vault secret in their
--    net.http_post headers. In-place merge: append x-internal-secret to the
--    existing headers jsonb literal. No-op if already merged or the job is absent.
DO $crons$
DECLARE
  rec record;
  names text[] := ARRAY[
    'cron-engagement-every-30-min',
    'cron-admin-digest-30min',
    'notify-homework-submission-every-minute',
    'weekly-admin-topic-check'
  ];
  nm text;
BEGIN
  FOREACH nm IN ARRAY names LOOP
    SELECT jobid, command INTO rec FROM cron.job WHERE jobname = nm;
    IF FOUND AND rec.command NOT ILIKE '%internal_fn_secret()%' THEN
      PERFORM cron.alter_job(
        rec.jobid,
        command := regexp_replace(
          rec.command,
          $re$headers\s*:=\s*('\{[^']*\}'::jsonb)$re$,
          $rep$headers := (\1 || jsonb_build_object('x-internal-secret', public.internal_fn_secret()))$rep$,
          'g'
        )
      );
    END IF;
  END LOOP;
END
$crons$;

-- 4) Patch public.track_video_progress (the DB caller of notify-completion) to
--    forward the Vault secret. Surgical: re-create from its own definition with the
--    header appended after the Authorization header, so nothing else changes.
DO $tvp$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'track_video_progress';

  IF d IS NULL THEN
    RAISE NOTICE 'track_video_progress not found; skipping header patch';
    RETURN;
  END IF;
  IF position('x-internal-secret' in d) > 0 THEN
    RETURN;  -- already patched
  END IF;

  d := replace(
    d,
    $q$'Authorization', 'Bearer ' || anon_key$q$,
    $q$'Authorization', 'Bearer ' || anon_key,
          'x-internal-secret', public.internal_fn_secret()$q$
  );
  EXECUTE d;
END
$tvp$;
