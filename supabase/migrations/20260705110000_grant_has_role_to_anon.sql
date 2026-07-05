-- Fix: an earlier hardening migration (20260428162429) revoked EXECUTE on
-- has_role() from anon. But 32 RLS policies across 25 tables call has_role for
-- the anon/public roles (e.g. the "courses admin write" FOR ALL policy). With
-- the revoke in place, any anonymous SELECT that evaluates such a policy fails
-- with: permission denied for function has_role — which breaks anonymous reads
-- such as the logged-out landing page's course list.
--
-- has_role() is SECURITY DEFINER and returns false for anon (auth.uid() is null),
-- so granting EXECUTE to anon does not widen data access; it only lets the RLS
-- policy expressions evaluate to false instead of throwing. This restores the
-- behavior of the live/production project.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_role'
  loop
    execute format('grant execute on function %s to anon', r.sig);
  end loop;
end $$;
