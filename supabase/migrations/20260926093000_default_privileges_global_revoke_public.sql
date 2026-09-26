-- SECURITY (root cause, third and final attempt): stop new functions being born anon-executable.
--
-- WHY THE FIRST TWO ATTEMPTS FAILED, precisely. `20260926073000` and `20260926080000` both ran
--     alter default privileges [for role postgres] IN SCHEMA public revoke execute on functions from public
-- and both were STRUCTURAL NO-OPS. PostgreSQL's own documentation uses that exact statement as its
-- example of a no-op, and says why:
--     "per-schema default privileges can only add privileges to the global setting,
--      not remove privileges granted by it."   (PG17 docs, ALTER DEFAULT PRIVILEGES)
-- The source states the asymmetry outright too (src/backend/catalog/aclchk.c, SetDefaultACL):
--     "global entries replace the hard-wired defaults, while others are added on."
--
--   * A GLOBAL entry (no IN SCHEMA, defaclnamespace = 0) REPLACES acldefault().
--   * A PER-SCHEMA entry is ADD-MERGED ON TOP of acldefault().
--
-- acldefault() for a FUNCTION always contains EXECUTE for PUBLIC ("case OBJECT_FUNCTION:
-- world_default = ACL_EXECUTE"). get_user_default_acl() substitutes acldefault() when no global row
-- exists, then ADD-merges the per-schema row (aclmerge only ever calls aclupdate with
-- ACL_MODECHG_ADD; it has no subtractive mode). So a per-schema row that merely LACKS a PUBLIC entry
-- means "inherit the baseline PUBLIC", never "suppress it" — and `revoke ... from public` against a
-- row that never had a PUBLIC entry removes nothing and raises nothing. This database has NO global
-- row at all (verified: every pg_default_acl row names a schema), so PUBLIC=EXECUTE was
-- un-suppressible by anything either earlier migration could say.
--
-- This reproduces `20260926080000`'s probe bit-for-bit:
--   acldefault('f',postgres) = {=X/postgres, postgres=X/postgres}
--   add-merge the stored row  {postgres=X/postgres, service_role=X/postgres}
--   =                         "=X/postgres | postgres=X/postgres | service_role=X/postgres"   <-- recorded value
-- The recorded `default_acl_postgres` was correct AND the function still got PUBLIC. Both at once.
-- (That also rules out a stale-catalog-snapshot cause: `service_role=X` can only have come from the
-- stored row, so the row was read, and it was current.)
--
-- THE FIX IS THE MISSING WORD: no `IN SCHEMA`. One global revoke replaces the baseline.
--
-- SCOPE, HONESTLY STATED:
--   * Forward-only. ALTER DEFAULT PRIVILEGES NEVER touches existing objects, so this cannot break
--     anything running today — and it does NOT close the 63 existing anon-executable SECURITY
--     DEFINER functions. Those need object-level revokes (separate PR, each needs its own caller
--     audit). Note carefully: of those 63, only ONE (`weekly_digest_set_enabled`) is reachable via
--     PUBLIC alone; 51 carry BOTH a PUBLIC and an explicit `anon` grant and 11 carry only an explicit
--     `anon` grant. So this migration is PREVENTION for future functions, not a cure for the existing
--     ones, and the cleanup PR must revoke `anon` BY NAME as well as PUBLIC.
--   * Covers postgres-OWNED future functions — which is everything this deploy pipeline creates
--     (the Management API session runs as postgres; `20260926080000` recorded current_role=postgres).
--     It does NOT cover functions owned by `supabase_admin`; altering that role's defaults needs a
--     membership we do not have (pg_has_role('postgres','supabase_admin','MEMBER') is false, which is
--     why that ALTER failed silently in 20260926080000). Measured, this limitation is benign: of the
--     390 functions in schema public, the 159 owned by supabase_admin are entirely `vector` (114) and
--     `citext` (45) extension operators, with ZERO of them SECURITY DEFINER. All 231 app functions —
--     and all 221 SECURITY DEFINER ones — are postgres-owned and therefore in scope.
--   * `postgres` owns functions in exactly three schemas today — public (231), extensions (49),
--     warmup (1) — so the global row's blast radius is those three, and EACH gets an explicit
--     per-schema grant below. Everything else belongs to platform roles (supabase_admin,
--     supabase_auth_admin, supabase_storage_admin, supabase_realtime_admin) and is untouched.
--
-- THREE GUARD RAILS. A global row applies to EVERY schema, and in a schema with no per-schema row
-- aclmerge(global, NULL) returns a COPY OF THE GLOBAL ROW — i.e. `{postgres=X}` and nothing else.
-- That is the trap: removing PUBLIC removes it for every grantee that was silently relying on it.
-- Each statement below exists because a specific role would otherwise lose access:
--   1. schema public → grant `authenticated`, `service_role`. `20260926080000` stripped anon AND
--      authenticated from that per-schema row. With PUBLIC now actually gone, a new browser-facing
--      RPC would be reachable by NOBODY but service_role and would 403 silently in production.
--      Net effect of this migration is therefore exactly: new functions stop being reachable by
--      `anon` (anyone on the internet holding the public key); signed-in users are unaffected.
--      Tightening `authenticated` too is deliberately LEFT for later, once the author-time lint
--      exists to catch a missing grant — that change needs a safety net first.
--   2. schema extensions → grant `anon`, `authenticated`, `service_role`. pgcrypto (36 fns),
--      uuid-ossp (10) and pg_stat_statements (3) are postgres-OWNED, so `ALTER EXTENSION ... UPDATE`
--      recreates their functions under the new global default. extensions.crypt / gen_salt / digest /
--      hmac / uuid_generate_v4 are reachable by anon+authenticated ONLY through `=X/postgres` today
--      (they carry no explicit grant), so an upgrade must not silently revoke them. There is no
--      postgres 'f' row for that schema yet, so this statement creates it.
--   3. schema warmup → grant `service_role`. THIS ONE WAS ALMOST MISSED, and it is the reason to
--      distrust "anon can't reach it, so it's fine": warmup.ledger_is_append_only() has NULL proacl
--      (the built-in default), and `service_role` executes it ONLY through PUBLIC. There is no
--      postgres 'f' row for warmup either, so without this statement the NEXT function created there
--      would be born `postgres=X` only and the service_role-only warmup API would silently 403.
--      Security-wise warmup was indeed already sealed — anon/authenticated have no USAGE on the
--      schema (nspacl is `postgres=UC/postgres | service_role=U/postgres`, set by
--      20260908120000_warmup_schema.sql) — but AVAILABILITY is a separate question from reachability,
--      and the global revoke touches both.
--
-- ACCEPTED TRADE-OFF, recorded so it is not a surprise later: if someone later runs
-- `CREATE EXTENSION ... WITH SCHEMA <new schema>` AS postgres, that extension's functions would be
-- born with the global default only (`postgres=X`) and need an explicit grant. Narrow: platform
-- extensions are supabase_admin-owned and unaffected, and all three schemas postgres creates
-- functions in today are covered above.
--
-- SELF-TEST — it probes TWO schemas, because statements 1 and 3 protect different roles:
--   * If the fix did NOT work (probe in public still anon-executable): RECORD IT, DO NOT RAISE. A
--     raise rolls the diagnostics back with everything else, which is exactly why 20260926073000
--     taught us nothing. Nothing is harmed by a no-op, and `admin_actions` keeps the evidence.
--   * If the fix went TOO FAR (public probe unreachable by authenticated/service_role, or the warmup
--     probe unreachable by service_role): RAISE and roll the whole migration back. The raise sits
--     outside any EXCEPTION handler and AFTER the audit insert, so it aborts the single implicit
--     transaction that is this whole file — all four ALTERs and the audit row revert together.
--
-- Idempotent + replay-safe: ALTER DEFAULT PRIVILEGES is declarative; both probe functions are
-- dropped. One deliberate exception: the audit INSERT has no dedupe key, so a pipeline retry (the
-- ledger is written AFTER the SQL) adds a second, byte-identical row. Harmless log noise, not a
-- second attempt — do NOT read `admin_actions` here as one-row-per-attempt.

do $dp$
declare
  _err_global text; _err_public text; _err_ext text; _err_warm text;
  _acl_global text; _acl_public text; _acl_ext text; _acl_warm text;
  _anon boolean; _authed boolean; _svc boolean; _proacl text;
  _warm_svc boolean; _warm_proacl text;
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

  -- 3. Preserve today's access for future postgres-owned functions in `extensions` (guard rail 2).
  begin
    execute 'alter default privileges for role postgres in schema extensions '
         || 'grant execute on functions to anon, authenticated, service_role';
  exception when others then _err_ext := sqlerrm;
  end;

  -- 4. Keep the service_role-only warmup API reachable (guard rail 3 — the almost-missed one).
  begin
    execute 'alter default privileges for role postgres in schema warmup '
         || 'grant execute on functions to service_role';
  exception when others then _err_warm := sqlerrm;
  end;

  -- ── Probe A (schema public): what does a new function ACTUALLY inherit? ──
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

  -- ── Probe B (schema warmup): service_role must NOT lose EXECUTE ──
  execute 'create or replace function warmup._dp_probe_warmup() returns int language sql as $q$ select 1 $q$';

  select has_function_privilege('service_role', 'warmup._dp_probe_warmup()', 'EXECUTE')
    into _warm_svc;

  select coalesce(array_to_string(p.proacl, ' | '), '(null = built-in default: owner + PUBLIC)')
    into _warm_proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'warmup' and p.proname = '_dp_probe_warmup';

  execute 'drop function if exists warmup._dp_probe_warmup()';

  -- Read the four rows back so the audit record is self-contained.
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

  select array_to_string(d.defaclacl, ' | ') into _acl_warm
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'warmup' and d.defaclobjtype = 'f'
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
            'warmup_new_function_service_role', _warm_svc,
            'warmup_new_function_proacl',  _warm_proacl,
            'default_acl_global',          coalesce(_acl_global, '(row absent)'),
            'default_acl_public',          coalesce(_acl_public, '(row absent)'),
            'default_acl_extensions',      coalesce(_acl_ext,    '(row absent)'),
            'default_acl_warmup',          coalesce(_acl_warm,   '(row absent)'),
            'err_global',                  coalesce(_err_global, 'none'),
            'err_public',                  coalesce(_err_public, 'none'),
            'err_extensions',              coalesce(_err_ext,    'none'),
            'err_warmup',                  coalesce(_err_warm,   'none'),
            'existing_anon_secdef_unchanged_by_design', _secdef_existing,
            'at', now()));

  -- Fail loud ONLY on the dangerous direction: nothing that works today may lose access.
  if not _authed or not _svc then
    raise exception
      'ABORT: a new function in schema public is no longer executable by authenticated(%) / '
      'service_role(%). Statement 2 must have failed (err_public=%). Rolling back rather than '
      'committing a state that would silently 403 every future browser RPC. proacl=%',
      _authed, _svc, coalesce(_err_public, 'none'), _proacl;
  end if;

  if not _warm_svc then
    raise exception
      'ABORT: a new function in schema warmup is no longer executable by service_role. '
      'Statement 4 must have failed (err_warmup=%). Rolling back rather than committing a state '
      'that would silently 403 the service_role-only warmup API. proacl=%',
      coalesce(_err_warm, 'none'), _warm_proacl;
  end if;
end $dp$;
