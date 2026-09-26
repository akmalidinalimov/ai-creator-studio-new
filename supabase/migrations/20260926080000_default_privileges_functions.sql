-- SECURITY (root cause): every new function in schema public is born anon-executable.
--
-- SECOND ATTEMPT. The first (20260926073000) was rolled back by its own self-test, which is exactly
-- what it was built to do — and the failure is more interesting than the fix:
--     "a NEWLY CREATED function is still anon-executable; ... still authenticated-executable"
-- So the three ALTER DEFAULT PRIVILEGES statements ran without error, and a function created
-- immediately afterwards in the same transaction STILL inherited anon. My model of why is wrong, and
-- the live catalog after the rollback confirmed the rollback itself was clean (defaults unchanged,
-- objects owned by postgres).
--
-- Candidate explanations I cannot separate without data from inside the deploy session:
--   a. the Management API session's CURRENT_ROLE is not `postgres`, so a bare ALTER DEFAULT PRIVILEGES
--      (which targets CURRENT_ROLE) edited a different role's row than the one consulted at creation;
--   b. the supabase_admin grantor row is the one that applies, and the `for role supabase_admin`
--      attempt silently failed into its exception handler;
--   c. a catalog-visibility subtlety: the new pg_default_acl row not being seen by a CREATE issued
--      later in the same transaction via EXECUTE inside a DO block.
--
-- THIS FILE MEASURES INSTEAD OF GUESSING. It:
--   1. targets BOTH grantors explicitly with FOR ROLE (each guarded, since we may not be a member of
--      supabase_admin) — which fixes (a) and (b) outright if either is the cause;
--   2. probes a throwaway function and records what it ACTUALLY inherited, including the raw proacl;
--   3. records CURRENT_ROLE, SESSION_USER and both post-change default ACLs;
--   4. DOES NOT RAISE. The previous version's raise rolled the diagnostics back with everything else,
--      so the one thing I needed to see never persisted. A failed run must leave evidence behind.
--
-- CONSEQUENCE, STATED PLAINLY: if the probe still shows anon, this migration will have applied without
-- achieving its goal, and `admin_actions.default_privileges_probe` will say so. That is deliberate —
-- ALTER DEFAULT PRIVILEGES only affects objects created afterwards, so a no-op is harmless, whereas
-- another silent rollback would teach me nothing. Existing functions are untouched either way.
--
-- Idempotent + replay-safe: ALTER DEFAULT PRIVILEGES is declarative; the probe function is dropped.

do $$
begin
  execute 'alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated';
exception when others then null;
end $$;

do $$
begin
  execute 'alter default privileges for role postgres in schema public grant execute on functions to service_role';
exception when others then null;
end $$;

do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated';
exception when others then null;
end $$;

do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public grant execute on functions to service_role';
exception when others then null;
end $$;

-- Bare form too, in case CURRENT_ROLE is neither of the above.
do $$
begin
  execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
  execute 'alter default privileges in schema public grant execute on functions to service_role';
exception when others then null;
end $$;

-- ───────────────────────── Probe + record (never raises) ─────────────────────────
do $probe$
declare
  _anon boolean; _authed boolean; _svc boolean; _proacl text;
  _acl_pg text; _acl_sa text; _cur text; _sess text; _anon_secdef int;
begin
  select current_role::text, session_user::text into _cur, _sess;

  execute 'create or replace function public._dp_probe() returns int language sql as $q$ select 1 $q$';

  select has_function_privilege('anon', 'public._dp_probe()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public._dp_probe()', 'EXECUTE'),
         has_function_privilege('service_role', 'public._dp_probe()', 'EXECUTE')
    into _anon, _authed, _svc;

  select coalesce(array_to_string(p.proacl, ' | '), '(null = built-in default: owner + PUBLIC)')
    into _proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_dp_probe';

  execute 'drop function if exists public._dp_probe()';

  select array_to_string(d.defaclacl, ' | ') into _acl_pg
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname='public' and d.defaclobjtype='f' and pg_get_userbyid(d.defaclrole)='postgres';

  select array_to_string(d.defaclacl, ' | ') into _acl_sa
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname='public' and d.defaclobjtype='f' and pg_get_userbyid(d.defaclrole)='supabase_admin';

  select count(*) into _anon_secdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.prosecdef and p.prokind='f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, case when _anon or _authed then 'default_privileges_probe_STILL_OPEN'
                     else 'default_privileges_probe_closed' end,
          jsonb_build_object(
            'new_function_anon', _anon,
            'new_function_authenticated', _authed,
            'new_function_service_role', _svc,
            'new_function_proacl', _proacl,
            'current_role', _cur,
            'session_user', _sess,
            'default_acl_postgres', coalesce(_acl_pg, '(row absent)'),
            'default_acl_supabase_admin', coalesce(_acl_sa, '(row absent)'),
            'anon_secdef_remaining', _anon_secdef,
            'at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'default_privileges_probe_crashed',
            jsonb_build_object('error', sqlerrm, 'at', now()));
  exception when others then null; end;
end $probe$;
