-- Support agent: diagnose a ticket only once the student has stopped writing (2026-10-07).
--
-- Ticket #1's description ("Shu dars nima xaqida chumadim") arrived 3 minutes after its screenshot. The bot now keeps
-- adding the student's follow-ups (words, screenshots, voice) to the ticket for 15 minutes (support.ts
-- SUPPORT_FOLLOWUP_MS), so the agent must not diagnose the first screenshot alone: a diagnosis is claimed only when the
-- ticket has been quiet for 2 minutes (support_ticket_append stamps support_tickets.updated_at on every follow-up) —
-- but never later than 8 minutes after it was queued, so a chatty student can't hold it back and the watchdog's
-- 10-minute "late" alarm stays meaningful.
--
-- Started from the LIVE definition (pg_get_functiondef md5 6404a688f17ed5d14c43f88fd4564190, identical to
-- 20261006204500); the only change is the quiet-period condition in `c`.

create or replace function public.support_diag_claim(_limit integer default 3)
returns table (diagnosis_id bigint, ticket_id bigint, user_id uuid, locale text, username text, display_name text,
               group_name text, messages jsonb, admin_messages jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_agent'), false) then
    return;
  end if;
  -- a row that crashed the worker 3 times: 'failed' (the watchdog reports it), never left leased for ever
  update public.support_diagnoses
     set status = 'failed', lease_until = null, error = coalesce(error, 'the worker failed 3 times'), updated_at = now()
   where status = 'leased' and lease_until < now() and attempts >= 3;
  return query
  with c as (
    select d.id from public.support_diagnoses d
      join public.support_tickets t on t.id = d.ticket_id
     where t.status = 'open'
       and (d.status = 'queued' or (d.status = 'leased' and d.lease_until < now()))
       and d.attempts < 3
       -- the student has stopped writing (follow-ups join the ticket for 15 min) — or 8 min have passed anyway
       and (t.updated_at < now() - interval '2 minutes' or d.created_at < now() - interval '8 minutes')
     order by d.id
     limit greatest(1, least(coalesce(_limit, 3), 10))
     for update of d skip locked
  ), u as (
    update public.support_diagnoses d
       set status = 'leased', lease_until = now() + interval '5 minutes', attempts = d.attempts + 1, updated_at = now()
      from c where d.id = c.id
    returning d.id, d.ticket_id
  )
  select u.id, t.id, t.user_id, t.locale, t.username, t.display_name, t.group_name, t.messages, t.admin_messages
    from u join public.support_tickets t on t.id = u.ticket_id;
end
$fn$;

revoke execute on function public.support_diag_claim(integer) from public, anon, authenticated;
grant execute on function public.support_diag_claim(integer) to service_role;
