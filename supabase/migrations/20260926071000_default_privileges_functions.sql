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
--   1. They are currently mitigated: verified that ZERO public tables have an anon DML grant while
--      relrowsecurity is false — RLS is carrying it, and RLS is applied consistently here.
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
-- Asserts BOTH directions: the default no longer grants anon, and no existing function lost anything.
-- Allowed to abort — this migration has no irreversible effect, and a silent half-application would
-- leave the class half-open while looking fixed.
do $selftest$
declare _bad text := ''; _acl text; _anon_secdef int; _has_role_ok boolean;
begin
  select array_to_string(d.defaclacl, ' | ') into _acl
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public' and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres';

  if _acl is not null and _acl like '%anon=X%' then
    _bad := _bad || 'postgres FUNCTION default still grants anon (' || _acl || '); ';
  end if;
  if _acl is not null and _acl like '%authenticated=X%' then
    _bad := _bad || 'postgres FUNCTION default still grants authenticated; ';
  end if;

  -- Existing functions must be untouched. has_role() is the canary: 91 of 113 RLS policies reference
  -- it and anon MUST keep EXECUTE or every logged-out page breaks (precedent:
  -- 20260705110000_grant_has_role_to_anon.sql).
  select has_function_privilege('anon', 'public.has_role(uuid, app_role)', 'EXECUTE') into _has_role_ok;
  if not _has_role_ok then
    _bad := _bad || 'anon LOST has_role -- this breaks every anonymous RLS read; ';
  end if;

  if not has_function_privilege('anon', 'public.get_public_setting(text)', 'EXECUTE') then
    _bad := _bad || 'anon LOST get_public_setting (breaks LessonPage for logged-out visitors); ';
  end if;

  select count(*) into _anon_secdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _bad = '' then 'default_privileges_hardened'
                       else 'default_privileges_harden_failed' end,
            jsonb_build_object('failures', nullif(_bad, ''),
                               'postgres_function_default_acl', _acl,
                               'anon_secdef_still_open', _anon_secdef,
                               'note', 'existing functions unchanged by design; TABLE/SEQUENCE defaults left for the owner',
                               'at', now()));
  exception when others then null; end;

  if _bad <> '' then
    raise exception 'default privileges self-test failed, rolling back: %', _bad;
  end if;
end $selftest$;
