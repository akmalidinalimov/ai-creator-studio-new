-- SECURITY (root cause, third and final attempt): stop new functions being born anon-executable.
--
-- WHY THE FIRST TWO ATTEMPTS FAILED, precisely. `20260926073000` and `20260926080000` both ran
--     alter default privileges [for role postgres] IN SCHEMA public revoke execute on functions from public
-- and both were STRUCTURAL NO-OPS. PostgreSQL treats the two forms of ALTER DEFAULT PRIVILEGES
-- asymmetrically, and the asymmetry is stated outright in the source (src/backend/catalog/aclchk.c,
-- SetDefaultACL): "global entries replace the hard-wired defaults, while others are added on."
--
--   * A GLOBAL entry (no IN SCHEMA, defaclnamespace = 0) REPLACES acldefault().
--   * A PER-SCHEMA entry is ADD-MERGED ON TOP of acldefault().
--
-- acldefault() for a FUNCTION always contains EXECUTE for PUBLIC. get_user_default_acl() substitutes
-- acldefault() when no global row exists, then ADD-merges the per-schema row (aclmerge is additive;
-- it has no subtractive mode). So a per-schema row that merely LACKS a PUBLIC entry means "inherit
-- the baseline PUBLIC", never "suppress it" — and `revoke ... from public` against a row that never
-- had a PUBLIC entry removes nothing and raises nothing. This database has NO global row at all
-- (verified: every pg_default_acl row names a schema), so PUBLIC=EXECUTE was un-suppressible by
-- anything either earlier migration could say.
--
-- This reproduces `20260926080000`'s probe bit-for-bit:
--   acldefault('f',postgres) = {=X/postgres, postgres=X/postgres}
--   add-merge the stored row  {postgres=X/postgres, service_role=X/postgres}
--   =                         "=X/postgres | postgres=X/postgres | service_role=X/postgres"   <-- recorded value
-- The recorded `default_acl_postgres` was correct AND the function still got PUBLIC. Both at once.
-- (That is also why this was NOT a stale-catalog-snapshot bug: the row really was updated.)
--
-- THE FIX IS THE MISSING WORD: no `IN SCHEMA`. One global revoke replaces the baseline.
--
-- SCOPE, HONESTLY STATED:
--   * Forward-only. ALTER DEFAULT PRIVILEGES NEVER touches existing objects, so this cannot break
--     anything running today — and it does NOT close the 63 existing anon-executable SECURITY
--     DEFINER functions. Those need object-level revokes (separate PR, each needs its own caller
--     audit). Note carefully: of those 63, only ONE is reachable via PUBLIC alone; 51 carry BOTH a
--     PUBLIC and an explicit `anon` grant and 11 carry only an explicit `anon` grant. So this
--     migration is PREVENTION for future functions, not a cure for the existing ones, and the
--     cleanup PR must revoke `anon` BY NAME as well as PUBLIC.
--   * Covers postgres-OWNED future functions — which is everything this deploy pipeline creates
--     (the Management API session runs as postgres; `20260926080000` recorded current_role=postgres).
--     It does NOT cover functions owned by `supabase_admin`; altering that role's defaults needs a
--     membership we do not have (that ALTER failed silently in 20260926080000). Measured, this
--     limitation is benign: of the 390 functions in schema public, the 159 owned by supabase_admin
--     are entirely `vector` (114) and `citext` (45) extension operators, with ZERO of them SECURITY
--     DEFINER. All 231 app functions — and all 221 SECURITY DEFINER ones — are postgres-owned and
--     therefore in scope.
--   * `postgres` owns functions in exactly three schemas today — public (231), extensions (49),
--     warmup (1) — so the global row's blast radius is those three. Everything else belongs to
--     platform roles (supabase_admin, supabase_auth_admin, supabase_storage_admin,
--     supabase_realtime_admin) and is untouched.
--
-- TWO GUARD RAILS, each for a real failure mode found while checking this:
--   1. Statement 2 re-grants `authenticated` in schema public. `20260926080000` stripped anon AND
--      authenticated from that per-schema row. With PUBLIC now actually gone, a new browser-facing
--      RPC would otherwise be reachable by NOBODY but service_role and fail with a silent 403 in
--      production. Net effect of this migration is therefore exactly: new functions stop being
--      reachable by `anon` (anyone on the internet holding the public key); signed-in users are
--      unaffected. Tightening `authenticated` too is deliberately LEFT for later, once the
--      author-time lint exists to catch a missing grant — that is a change that needs a safety net.
--   2. Statement 3 preserves today's access for future postgres-owned functions in `extensions`.
--      pgcrypto (36 fns), uuid-ossp (10) and pg_stat_statements (3) are postgres-OWNED, so an
--      `ALTER EXTENSION ... UPDATE` recreates their functions under the new global default. Today
--      extensions.crypt/gen_salt/digest/hmac/uuid_generate_v4 are anon+authenticated executable; an
--      upgrade must not silently revoke them. (Column defaults are safe either way: they print as
--      bare `gen_random_uuid()`, which resolves to the core pg_catalog one, not pgcrypto's.)
--
-- WHY THERE IS NO THIRD GUARD RAIL FOR `warmup` (so the next reader need not re-derive it): nothing
-- in that schema is reachable by anon/authenticated no matter what a function's own EXECUTE ACL says,
-- because they lack USAGE on the schema itself. Verified live — warmup's nspacl is
-- `postgres=UC/postgres | service_role=U/postgres`, i.e. has_schema_privilege('anon','warmup','USAGE')
-- is false — which is what `20260908120000_warmup_schema.sql` set up on purpose. No schema USAGE
-- means the object is unreachable, so a missing PUBLIC grant there changes nothing.
--
-- ACCEPTED TRADE-OFF, recorded so it is not a surprise later: a global row applies to every schema in
-- which `postgres` creates functions. If someone later runs `CREATE EXTENSION ... WITH SCHEMA public`
-- AS postgres, that extension's operator functions would be born without PUBLIC, so `anon` could not
-- use them until granted explicitly (signed-in users still could — statement 2 grants
-- `authenticated`). This is narrow: platform-installed extensions are owned by supabase_admin and
-- unaffected, and both extensions currently in public (vector, citext) are already installed. The
-- remedy if it ever bites is one explicit grant scoped to that extension's functions.
--
-- SELF-TEST ASYMMETRY — deliberate, and it is the lesson from 20260926073000:
--   * If the fix did NOT work (probe still anon-executable): RECORD IT, DO NOT RAISE. A raise rolls
--     the diagnostics back with everything else, which is exactly why the first attempt taught us
--     nothing. Nothing is harmed by a no-op, and `admin_actions` keeps the evidence.
--   * If the fix went TOO FAR (probe not executable by `authenticated`/`service_role`, i.e. statement
--     2 failed): RAISE and roll the whole migration back. The raise sits outside any EXCEPTION
--     handler and AFTER the audit insert, so it aborts the single implicit transaction that is this
--     whole file — all three ALTERs and the audit row revert together. That state would silently
--     break every future browser RPC, so it must not be allowed to commit.
--
-- Idempotent + replay-safe: ALTER DEFAULT PRIVILEGES is declarative; the probe function is dropped.
-- One deliberate exception: the audit INSERT has no dedupe key, so a pipeline retry (the ledger is
-- written AFTER the SQL) adds a second, byte-identical row. That is harmless log noise, not a second
-- attempt — do NOT read `admin_actions` here as one-row-per-attempt.

do $dp$
declare
  _err_global text; _err_public text; _err_ext text;
  _acl_global text; _acl_public text; _acl_ext text;
  _anon boolean; _authed boolean; _svc boolean; _proacl text;
  _secdef_existing int;
begin
  -- Existing functions are untouched by design; recorded so the number is not misread as failure.
  select count(*) into _secdef_existing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  -- 1. THE FIX: a GLOBAL entry replaces acldefault(), dropping its hard-wired PUBLIC EXECUTE.
  begin
    execute 'alter default privileges for role postgres revoke execute on functions from public';
  exception when others then _err_global := sqlerrm;
  end;

  -- 2. Keep signed-in users working in schema public (per-schema entries are add-merged on top).
  begin
    execute 'alter default privileges for role postgres in schema public '
         || 'grant execute on functions to authenticated, service_role';
  exception when others then _err_public := sqlerrm;
  end;

  -- 3. Preserve today's access for future postgres-owned functions in `extensions` (see header).
  begin
    execute 'alter default privileges for role postgres in schema extensions '
         || 'grant execute on functions to anon, authenticated, service_role';
  exception when others then _err_ext := sqlerrm;
  end;

  -- ── Probe: create a throwaway function and see what it ACTUALLY inherited ──
  execute 'create or replace function public._dp_probe_global() returns int language sql as $q$ select 1 $q$';

  select has_function_privilege('anon',          'public._dp_probe_global()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public._dp_probe_global()', 'EXECUTE'),
         has_function_privilege('service_role',  'public._dp_probe_global()', 'EXECUTE')
    into _anon, _authed, _svc;

  select coalesce(array_to_string(p.proacl, ' | '), '(null = built-in default: owner + PUBLIC)')
    into _proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_dp_probe_global';

  execute 'drop function if exists public._dp_probe_global()';

  -- Read the three rows back so the audit record is self-contained.
  select array_to_string(d.defaclacl, ' | ') into _acl_global
  from pg_default_acl d
  where d.defaclnamespace = 0 and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres';

  select array_to_string(d.defaclacl, ' | ') into _acl_public
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public' and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres';

  select array_to_string(d.defaclacl, ' | ') into _acl_ext
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'extensions' and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres';

  insert into public.admin_actions (actor_user_id, action, details)
  values (null,
          case when _anon then 'default_privileges_global_STILL_OPEN'
               else 'default_privileges_global_closed' end,
          jsonb_build_object(
            'new_function_anon',           _anon,
            'new_function_authenticated',  _authed,
            'new_function_service_role',   _svc,
            'new_function_proacl',         _proacl,
            'default_acl_global',          coalesce(_acl_global, '(row absent)'),
            'default_acl_public',          coalesce(_acl_public, '(row absent)'),
            'default_acl_extensions',      coalesce(_acl_ext,    '(row absent)'),
            'err_global',                  coalesce(_err_global, 'none'),
            'err_public',                  coalesce(_err_public, 'none'),
            'err_extensions',              coalesce(_err_ext,    'none'),
            'existing_anon_secdef_unchanged_by_design', _secdef_existing,
            'at', now()));

  -- Fail loud ONLY on the dangerous direction: signed-in users must keep access.
  if not _authed or not _svc then
    raise exception
      'ABORT: a new function is no longer executable by authenticated(%) / service_role(%). '
      'Statement 2 must have failed (err_public=%). Rolling back rather than committing a state '
      'that would silently 403 every future browser RPC. proacl=%',
      _authed, _svc, coalesce(_err_public, 'none'), _proacl;
  end if;
end $dp$;
