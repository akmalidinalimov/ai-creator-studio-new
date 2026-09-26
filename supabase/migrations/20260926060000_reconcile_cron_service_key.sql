-- Reconcile public.cron_service_key() into version control, with a safe ACL from the start.
--
-- WHY THIS EXISTS: the function is in PRODUCTION but in NO tracked migration. Verified — 9 migrations
-- REFERENCE it inside cron.schedule() command text:
--   20260705200000_canary_cron.sql             20260707040000_inactive30_and_teacher_digest.sql
--   20260721160000_reputation_and_traffic_watchdog.sql   20260723120000_admin_broadcast.sql
--   20260810160000_attribute_internal_notify_crons.sql   20260810180000_teacher_daily_digest_cron.sql
--   20260814225133_schedule_teacher_engagement_nudge.sql 20260903140000_grade_card_backfill_and_cron.sql
--   20260903160000_bitrix_lead_sync.sql
-- and ZERO define it. So a database rebuilt from this repo alone would not have the function, and all
-- nine of those cron jobs would fail on their first tick — a disaster-recovery gap, silent until the
-- day it matters. Precedent for the same thing happening before: see the header of
-- 20260609100000_internal_fn_secret_vault_hardening.sql ("ALREADY APPLIED IN PRODUCTION via the
-- Lovable SQL editor ... reconciliation migration"). This is that, for cron_service_key.
--
-- WHY IT ALSO MATTERS FOR SECURITY: being untracked is very likely HOW it ended up anon-executable.
-- Its three sibling Vault accessors — internal_fn_secret(), ops_github_pat(), ops_notify_secret() —
-- were each created by a tracked migration with `revoke ... from public, anon, authenticated; grant
-- ... to service_role;` baked in from day one, and all three are correctly locked down today.
-- cron_service_key() is the only one of the four with no migration, and it was the only one leaking:
-- `anon` could call it over /rest/v1/rpc and receive the decrypted CRON_SERVICE_KEY, whose own vault
-- description is "service_role key for pg_cron edge-function calls" — the key that bypasses ALL RLS.
-- 20260925201000 closed that. This file makes sure a REBUILD cannot re-open it, by shipping the
-- function and its ACL together, the way the siblings always did.
--
-- BODY IS THE LIVE DEFINITION, CAPTURED VERBATIM from pg_get_functiondef() — not retyped, not
-- "improved". Owner in production is `postgres`, which is what the migration runner creates it as, so
-- CREATE OR REPLACE here is a true no-op against the current database.
--
-- ⚠️ THE SECRET ITSELF IS NOT IN VERSION CONTROL AND MUST NOT BE. On a fresh rebuild this function
-- returns NULL until an owner inserts CRON_SERVICE_KEY into the vault, which is the same
-- gracefully-dormant contract CLAUDE.md already describes for ops_github_pat() / ops_notify_secret()
-- ("NULL = flow gracefully dormant"). The nine cron jobs would then post without a valid apikey and
-- fail visibly rather than silently — acceptable, and better than the function not existing at all.
--
-- ⚠️ SEPARATE, STILL OUTSTANDING FOR THE OWNER: ROTATE CRON_SERVICE_KEY. It was reachable by anyone
-- holding the public anon key from 2026-07-05 (created, never rotated — vault updated_at equals
-- created_at) until 2026-09-25. Request logs show no call to /rest/v1/rpc/cron_service_key in the last
-- 24 hours, and that query was confirmed sound because it returns real traffic for other RPCs — but
-- Supabase caps log queries at 24 hours, so the preceding ~82 days cannot be verified either way.
-- Treat it as exposed. This migration cannot un-expose it.
--
-- Idempotent + replay-safe: create-or-replace plus declarative REVOKE/GRANT.

create or replace function public.cron_service_key()
returns text
language sql
stable
security definer
set search_path to 'public', 'vault'
as $function$ select decrypted_secret from vault.decrypted_secrets where name='CRON_SERVICE_KEY' order by created_at desc limit 1 $function$;

-- The ACL ships WITH the function, which is the whole point of this file. PUBLIC is named first
-- because that is where the grant actually lived: a bare `revoke ... from anon` is a no-op against an
-- inherited PUBLIC grant, which is exactly how this stayed invisible.
revoke execute on function public.cron_service_key() from public, anon, authenticated;
grant  execute on function public.cron_service_key() to service_role;

-- ───────────────────────── Deploy self-test (fails loud) ─────────────────────────
-- Allowed to abort: this migration is a create-or-replace of an identical body plus declarative
-- grants, so there is nothing whose rollback would lose real work. A reconciliation that quietly
-- re-opened the leak would be worse than no reconciliation at all.
do $selftest$
declare _bad text := '';
begin
  if has_function_privilege('anon', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'anon can execute cron_service_key; ';
  end if;
  if has_function_privilege('authenticated', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'authenticated can execute cron_service_key; ';
  end if;
  if not has_function_privilege('service_role', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'service_role LOST cron_service_key (breaks 9 cron jobs); ';
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _bad = '' then 'cron_service_key_reconciled'
                       else 'cron_service_key_reconcile_failed' end,
            jsonb_build_object(
              'failures', nullif(_bad, ''),
              'referencing_migrations', 9,
              'note', 'function was live but untracked; owner must still ROTATE CRON_SERVICE_KEY',
              'at', now()));
  exception when others then null; end;

  if _bad <> '' then
    raise exception 'cron_service_key reconcile self-test failed, rolling back: %', _bad;
  end if;
end $selftest$;
