-- CLEANUP: remove the one synthetic lead left behind by the 2026-09-04 end-to-end test of the landing
-- lead form (PR #156). The verification bar requires synthetic test data to be deleted with zero
-- residue; this row was the residue.
--
-- WHY NOW: the Bitrix24 lead sync (PR #155) is dormant until the owner sets BITRIX_WEBHOOK_URL. When it
-- is switched on, a catch-up could push this fake lead into the real CRM. Deleting it first means it
-- can never reach sales.
--
-- SAFETY: verified read-only on 2026-09-26 — exactly one row has source = 'e2e-test'; nothing references
-- public.leads by foreign key; the table has no triggers. The predicate names the id AND the source,
-- so it can only ever touch this one synthetic row. Idempotent: a replay deletes nothing.

delete from public.leads
where id = '1e69dba4-c3ff-4f77-9740-bb850985fdcd'
  and source = 'e2e-test';

do $$
begin
  if exists (select 1 from public.leads where id = '1e69dba4-c3ff-4f77-9740-bb850985fdcd') then
    raise exception 'ABORT: the e2e-test lead is still present';
  end if;
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'e2e_test_lead_deleted',
         jsonb_build_object('lead_id', '1e69dba4-c3ff-4f77-9740-bb850985fdcd', 'from_pr', 156, 'at', now())
  where not exists (select 1 from public.admin_actions where action = 'e2e_test_lead_deleted');
end $$;
