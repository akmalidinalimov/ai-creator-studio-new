-- Autonomous-ops Phase 2: Vault accessor for the ops-notify auth secret (2026-07-12).
-- FIRST MIGRATION APPLIED BY THE DEPLOY PIPELINE (label-gated, ledgered) — not by hand.
--
-- The secret VALUE is inserted once by the owner in the SQL editor (never committed):
--   select vault.create_secret('<random hex>', 'OPS_NOTIFY_SECRET', 'ops-notify caller auth');
-- Until then this accessor returns NULL and ops-notify 403s every caller (gracefully dormant).
create or replace function public.ops_notify_secret()
returns text language sql stable security definer
set search_path = public, vault
as $fn$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'OPS_NOTIFY_SECRET'
  order by created_at desc
  limit 1;
$fn$;
revoke execute on function public.ops_notify_secret() from public, anon, authenticated;
grant execute on function public.ops_notify_secret() to service_role;
