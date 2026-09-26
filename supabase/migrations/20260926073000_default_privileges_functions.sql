-- SECURITY (root cause): every new function in schema public is born anon-executable.
--
-- THIS IS WHY THE LEAK KEPT HAPPENING. pg_default_acl for schema public currently reads:
--
--   grantor          object     default ACL
--   ---------------  ---------  --------------------------------------------------
--   postgres         FUNCTION   postgres=X | anon=X | authenticated=X | service_role=X
--   supabase_admin   FUNCTION   postgres=X | anon=X | authenticated=X | service_role=X
--   postgres         TABLE      postgres=arwdDxtm | anon=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
--   supabase_admin   TABLE      (same)
--   postgres         SEQUENCE   postgres=rwU | anon=rwU | authenticated=rwU | service_role=rwU
--
-- Migrations run as `postgres`. So EVERY function a migration creates is granted to `anon` before
-- anyone writes a line of SQL, and PostgREST exposes it at /rest/v1/rpc/<name> to anyone holding the
-- publishable anon key — which ships in the browser bundle. That is not a mistake someone made once;
-- it is the default, and it re-arms itself every time.
--
-- Evidence it re-arms: 20260925201000 revoked 13 functions. The audit that followed still found 64
-- anon-executable SECURITY DEFINER functions, including several whose OWN migrations had revoked anon
-- years-of-commits ago — because `drop function ... ; create function ...` discards the ACL and
-- re-applies these defaults. cron_service_key(), which returned the service_role key to anyone who
-- asked, is the worst thing this default ever produced.
--
-- PREVENTION HIERARCHY: individual revokes are layer 5, a backstop applied after the fact, one
-- function at a time, forever. This is the layer-2 fix — it makes the bad state unrepresentable for
-- every function created from here on.
--
-- ═══ SCOPE: FUNCTIONS ONLY, DELIBERATELY ═══
-- TABLES and SEQUENCES are left alone tonight even though their defaults are worse on paper
-- (anon=arwdDxtm is full insert/update/delete on any new table). Two reasons:
--   1. They are currently mitigated, and the check is stronger than 'mostly': ALL 81 public tables
--      have relrowsecurity ON. Zero tables without RLS, therefore zero anon-reachable unprotected
--      tables. RLS is genuinely carrying this today.
--   2. Revoking the TABLE default changes how every future table must be set up, and a table with no
--      grant is invisible regardless of its RLS policies. That is a bigger behavioural change than
--      belongs in an unattended migration.
-- The residual risk is real and is the owner's call: ONE future `create table` without RLS is a
-- world-writable table. Recommended follow-up, not done here:
--   alter default privileges in schema public revoke all on tables from public, anon, authenticated;
--   alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
--
-- ═══ WHAT CHANGES FOR FUTURE WORK — READ THIS BEFORE WRITING A NEW RPC ═══
-- A new function is no longer reachable from the browser unless the migration says so explicitly:
--   grant execute on function public.my_new_rpc(...) to authenticated;   -- signed-in users
--   grant execute on function public.my_new_rpc(...) to anon;            -- ONLY if a logged-out page needs it
-- Forgetting this fails LOUD — PostgREST returns 404 / permission denied the first time the page
-- calls it — rather than silently publishing the function to the internet. That is the trade, and it
-- is the right way round.
--
-- ═══ WHY THIS CANNOT BREAK ANYTHING TODAY ═══
-- ALTER DEFAULT PRIVILEGES applies ONLY to objects created AFTER it runs. Not one existing function's
-- ACL changes. There is no data change, no function body change, and nothing for a running request to
-- notice. The self-test verifies both halves: the default is fixed, and existing grants are untouched.
--
-- Idempotent + replay-safe: ALTER DEFAULT PRIVILEGES is declarative and converges.

-- The grantor that matters: migrations and the SQL editor both run as `postgres`.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- service_role keeps it: edge functions authenticate as service_role and legitimately call many of
-- these. Stated explicitly rather than relied upon.
alter default privileges in schema public grant execute on functions to service_role;

-- supabase_admin owns Supabase's own internal objects and we are very likely not a member of that
-- role. Attempt it, but never fail the migration over it — its objects are not ours to manage.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated';
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'default_privileges_supabase_admin_skipped',
            jsonb_build_object('reason', sqlerrm,
                               'note', 'expected unless we are a member of supabase_admin; the postgres grantor is the one migrations use',
                               'at', now()));
  exception when others then null; end;
end $$;

-- ───────────────────────── Deploy self-test (fails loud) ─────────────────────────
-- TESTS THE OUTCOME, NOT A PROXY. An earlier draft only inspected the pg_default_acl catalog row for
-- an 'anon=X' substring. That is a proxy with a real blind spot: Postgres DELETES the row entirely
-- when a customised ACL converges back to the built-in default ({owner=X, PUBLIC=X}), so a future
-- change could leave PUBLIC holding EXECUTE again while a `row is not null and row like '%anon=X%'`
-- check reported success. (This migration is not exposed to that — revoking PUBLIC and granting
-- service_role both differ from the built-in default, so the row must persist — but a test that only
-- works because of a property of today's statements is a test waiting to go wrong.)
--
-- So: actually create a throwaway function and ask the question directly. If a brand-new function is
-- still anon-executable, the whole point of this migration has failed, whatever the catalog says.
-- The scratch function is dropped immediately, and would vanish with the rollback regardless.
do $selftest$
declare _bad text := ''; _acl text; _anon_secdef int;
begin
  -- 1. THE REAL TEST: what does a function created right now actually inherit?
  execute 'create or replace function public._dp_scratch_probe() returns int language sql as $q$ select 1 $q$';

  if has_function_privilege('anon', 'public._dp_scratch_probe()', 'EXECUTE') then
    _bad := _bad || 'a NEWLY CREATED function is still anon-executable; ';
  end if;
  if has_function_privilege('authenticated', 'public._dp_scratch_probe()', 'EXECUTE') then
    _bad := _bad || 'a NEWLY CREATED function is still authenticated-executable; ';
  end if;
  if not has_function_privilege('service_role', 'public._dp_scratch_probe()', 'EXECUTE') then
    _bad := _bad || 'a NEWLY CREATED function is NOT service_role-executable (breaks edge functions); ';
  end if;

  execute 'drop function if exists public._dp_scratch_probe()';

  -- 2. Existing functions must be untouched. has_role() is the canary: 91 of 113 RLS policies across
  -- 63 tables reference it (verified live) and anon MUST keep EXECUTE or every logged-out page breaks
  -- (precedent: 20260705110000_grant_has_role_to_anon.sql).
  if not has_function_privilege('anon', 'public.has_role(uuid, public.app_role)', 'EXECUTE') then
    _bad := _bad || 'anon LOST has_role -- this breaks every anonymous RLS read; ';
  end if;
  if not has_function_privilege('anon', 'public.get_public_setting(text)', 'EXECUTE') then
    _bad := _bad || 'anon LOST get_public_setting (breaks LessonPage for logged-out visitors); ';
  end if;

  select array_to_string(d.defaclacl, ' | ') into _acl
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public' and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres';

  select count(*) into _anon_secdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  -- NOTE: on failure this row is rolled back with everything else -- the raise below aborts the same
  -- transaction it was written in. The durable failure signal is the pipeline's: the migration is not
  -- ledgered and the deploy step goes red. Recorded here only for the success path.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _bad = '' then 'default_privileges_hardened'
                       else 'default_privileges_harden_failed' end,
            jsonb_build_object('failures', nullif(_bad, ''),
                               'postgres_function_default_acl', _acl,
                               'anon_secdef_still_open', _anon_secdef,
                               'note', 'existing functions unchanged by design; TABLE/SEQUENCE defaults left for the owner (all 81 public tables have RLS on)',
                               'at', now()));
  exception when others then null; end;

  if _bad <> '' then
    raise exception 'default privileges self-test failed, rolling back: %', _bad;
  end if;
end $selftest$;
