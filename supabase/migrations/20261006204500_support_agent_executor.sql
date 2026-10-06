-- Support auto-resolver, the executor half (owner, 2026-10-06). Everything needed to accept real requests and fix them
-- — but the agent stays OFF: this migration does NOT switch it on. The owner turns it on deliberately, once, with
--     update public.platform_settings set value = value || '{"enabled": true, "mode": "propose"}' where key = 'support_agent';
-- In 'propose' mode every «❓ Yordam» ticket is diagnosed and the admins get the root cause + the proposed fix + the
-- drafted reply; NOTHING changes until an admin taps ✅ (the owner's standing decision: every fix is approved), and only
-- the whitelisted actions can run at all. While enabled = false the worker claims nothing and the crons are no-ops.
--
-- This migration (the SQL half; the worker is supabase/functions/support-agent, the buttons are the bot's sa:):
--   * worker RPCs: support_diag_claim (leased), support_diag_record, support_proposal_create, support_proposal_messages,
--     support_ai_call_record, support_ai_spent_today, support_proposal_decide;
--   * support_apply_fix(proposal, admin) — the ONLY write path: kill-switch, row lock + idempotency, TTL, the admin is a
--     real admin and not the student, the rule RE-EVALUATED on a fresh snapshot (same rule + same args, else
--     'superseded'), the whitelisted action run as that admin (auth.uid() = the admin → the wrapped RPCs' own guards and
--     audit apply), then VERIFIED (the rule no longer fires → 'verified', else 'verify_failed'), audited;
--   * heal_split as its own guarded step (archive the EMPTY twin, never delete; the keeper takes the group);
--   * the reply's delivery bookkeeping: support_proposal_claim_delivery (one tap ever sends) and
--     support_proposal_delivered (records it, marks the ticket answered); a fix whose reply never went out is visible;
--   * a smoke test of the RPCs on fixture rows, rolled back by a sentinel (plpgsql binds lazily — a wrong column or
--     type would otherwise only fail at the first admin tap);
--   * support_agent_watchdog() (hourly :33) — stuck / failing / unverified, DM to the admins;
--   * the worker cron (every minute; a no-op while the agent is off). NOT the switch — see above.

-- delivery bookkeeping: the bot claims the reply before sending it and records the outcome after
alter table public.support_fix_proposals
  add column if not exists delivered_at timestamptz,
  add column if not exists delivery_claimed_at timestamptz,
  add column if not exists delivery_error text;

-- ───────────────────────────── worker RPCs ─────────────────────────────
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

create or replace function public.support_diag_record(_id bigint, _status text, _snapshot jsonb, _hits jsonb, _llm jsonb,
                                                      _cost numeric, _error text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update public.support_diagnoses
     set status = case when _status in ('done', 'needs_human', 'failed', 'queued') then _status else 'failed' end,
         lease_until = null, snapshot = _snapshot, rule_hits = _hits, llm = _llm,
         cost_usd = coalesce(_cost, 0), error = left(_error, 500), updated_at = now()
   where id = _id
$fn$;

create or replace function public.support_proposal_create(_ticket bigint, _diag bigint, _hit jsonb, _message text, _status text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _args jsonb := coalesce(_hit->'args', '{}'::jsonb);
  _hash text := md5(coalesce(_hit->>'rule', '') || ':' || _args::text);
  _id bigint;
begin
  insert into public.support_fix_proposals (ticket_id, diagnosis_id, rule_id, action, args, args_hash, class, confidence,
                                            evidence, student_message, status)
  values (_ticket, _diag, coalesce(_hit->>'rule', 'R99_unknown'), _hit->>'action', _args, _hash,
          coalesce(_hit->>'class', 'needs_human'), coalesce(_hit->>'confidence', 'low'), left(_hit->>'evidence', 2000),
          left(_message, 3500), case when _status in ('proposed', 'shadow') then _status else 'proposed' end)
  on conflict (ticket_id, rule_id, args_hash) where status in ('shadow', 'proposed') do nothing
  returning id into _id;
  if _id is null then
    select p.id into _id from public.support_fix_proposals p
     where p.ticket_id = _ticket and p.rule_id = coalesce(_hit->>'rule', 'R99_unknown') and p.args_hash = _hash
       and p.status in ('shadow', 'proposed') limit 1;
  end if;
  return _id;
end
$fn$;

create or replace function public.support_proposal_messages(_id bigint, _msgs jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update public.support_fix_proposals
     set admin_messages = admin_messages || case when jsonb_typeof(_msgs) = 'array' then _msgs else '[]'::jsonb end,
         updated_at = now()
   where id = _id
$fn$;

create or replace function public.support_ai_call_record(_diag bigint, _provider text, _model text, _tin integer, _tout integer,
                                                         _cost numeric, _ok boolean, _error text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  insert into public.support_ai_calls (diagnosis_id, provider, model, input_tokens, output_tokens, cost_usd, ok, error)
  values (_diag, _provider, _model, _tin, _tout, coalesce(_cost, 0), coalesce(_ok, false), left(_error, 500))
$fn$;

create or replace function public.support_ai_spent_today()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(sum(cost_usd), 0) from public.support_ai_calls
   where created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent')
$fn$;

-- reject / hand to a human: the proposal is closed, nothing runs
create or replace function public.support_proposal_decide(_id bigint, _admin uuid, _decision text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _p public.support_fix_proposals;
begin
  if not (public.has_role(_admin, 'admin'::public.app_role)) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  update public.support_fix_proposals
     set status = 'rejected', decided_by = _admin, decided_at = now(),
         result = jsonb_build_object('decision', _decision), updated_at = now()
   where id = _id and status in ('proposed', 'shadow')
  returning * into _p;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;
  insert into public.admin_actions (actor_user_id, action, target_resource_type, target_resource_id, details)
  values (_admin, 'support_fix_rejected', 'support_fix_proposal', null,
          jsonb_build_object('proposal_id', _id, 'ticket_id', _p.ticket_id, 'rule', _p.rule_id, 'decision', _decision));
  return jsonb_build_object('ok', true, 'status', 'rejected', 'ticket_id', _p.ticket_id);
end
$fn$;

-- the bot's delivery of an approved reply: CLAIMED before the send (one tap ever sends), RECORDED after
create or replace function public.support_proposal_claim_delivery(_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  update public.support_fix_proposals
     set delivery_claimed_at = now(), updated_at = now()
   where id = _id and status in ('verified', 'sent') and delivered_at is null
     and (delivery_claimed_at is null or delivery_claimed_at < now() - interval '2 minutes');
  return found;
end
$fn$;

create or replace function public.support_proposal_delivered(_id bigint, _ok boolean, _error text, _admin uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _p public.support_fix_proposals;
begin
  if coalesce(_ok, false) then
    update public.support_fix_proposals
       set delivered_at = now(), delivery_error = null, updated_at = now()
     where id = _id
    returning * into _p;
    -- answered — unless it was a code-bug "we're looking into it", which stays open until the fix
    if found and _p.class <> 'code_bug' then
      update public.support_tickets
         set status = 'answered', answered_at = now(), answered_by = _admin,
             reply_text = left(_p.student_message, 4000), updated_at = now()
       where id = _p.ticket_id and status = 'open';
    end if;
  else
    -- undelivered (blocked the bot?): released, so a later tap can try again; the error is kept
    update public.support_fix_proposals
       set delivery_claimed_at = null, delivery_error = coalesce(left(_error, 300), 'undelivered'), updated_at = now()
     where id = _id and delivered_at is null;
  end if;
end
$fn$;

-- ───────────────────────────── the executor ─────────────────────────────
create or replace function public.support_heal_split(_keeper uuid, _twin uuid, _group uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
-- Archive the EMPTY username-only twin and give its group (and username, if the keeper has none) to the keeper.
-- Re-checked here, whatever the proposal said: the pair must still be in identity_split_pairs() with b_empty.
declare
  _uname text;
  _enr jsonb;
begin
  if not exists (select 1 from public.identity_split_pairs() s where s.a_id = _keeper and s.b_id = _twin and s.b_empty) then
    raise exception 'heal_split: the pair is no longer an empty split';
  end if;
  select telegram_username into _uname from public.profiles where id = _twin;
  update public.profiles
     set telegram_username = null, group_id = null, status = 'archived', archived_at = now()
   where id = _twin and telegram_id is null;
  with d as (delete from public.enrollments en where en.user_id = _twin returning to_jsonb(en) as e)
  select coalesce(jsonb_agg(d.e), '[]'::jsonb) into _enr from d;
  update public.profiles
     set telegram_username = coalesce(telegram_username, _uname),
         group_id = coalesce(group_id, _group)
   where id = _keeper;
  return jsonb_build_object('archived', _twin, 'keeper', _keeper, 'group', _group, 'deleted_enrollments', _enr);
end
$fn$;

create or replace function public.support_apply_fix(_proposal bigint, _admin uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _cfg jsonb := coalesce((select value from public.platform_settings where key = 'support_agent'), '{}'::jsonb);
  _p public.support_fix_proposals;
  _t public.support_tickets;
  _snap jsonb;
  _hits jsonb;
  _res jsonb := '{}'::jsonb;
  _verified boolean;
  _status text;
  _err text;
  _prev_sub text;
  _prev_claims text;
  _rx jsonb;
  _rs jsonb;
begin
  if not coalesce((_cfg->>'enabled')::boolean, false) or coalesce(_cfg->>'mode', 'off') <> 'propose' then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  select * into _p from public.support_fix_proposals where id = _proposal for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if _p.status in ('applied', 'verified', 'verify_failed', 'sent') then
    return coalesce(_p.result, '{}'::jsonb) || jsonb_build_object('ok', true, 'already', true, 'status', _p.status);
  end if;
  if _p.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'reason', _p.status);
  end if;
  select * into _t from public.support_tickets where id = _p.ticket_id;
  if not (public.has_role(_admin, 'admin'::public.app_role))
     or _admin = _t.user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  if _p.created_at < now() - make_interval(hours => coalesce((_cfg->>'proposal_ttl_h')::int, 24)) then
    update public.support_fix_proposals set status = 'expired', updated_at = now() where id = _proposal;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- the ticket was answered by hand meanwhile: the proposal is moot — no second reply, no fix on a closed ticket
  if _t.status is distinct from 'open' then
    update public.support_fix_proposals
       set status = 'superseded', decided_by = _admin, decided_at = now(),
           result = jsonb_build_object('reason', 'ticket_closed'), updated_at = now()
     where id = _proposal;
    return jsonb_build_object('ok', false, 'reason', 'ticket_closed', 'ticket_id', _p.ticket_id);
  end if;

  -- a reply / a human / a code bug: nothing to execute — the bot sends the approved reply
  if _p.action is null then
    update public.support_fix_proposals
       set status = 'sent', decided_by = _admin, decided_at = now(), result = jsonb_build_object('action', null), updated_at = now()
     where id = _proposal;
    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (_admin, 'support_reply_approved', _t.user_id, 'support_fix_proposal', null,
            jsonb_build_object('proposal_id', _proposal, 'ticket_id', _t.id, 'rule', _p.rule_id));
    return jsonb_build_object('ok', true, 'status', 'sent', 'action', null, 'ticket_id', _t.id);
  end if;

  -- the rule must still say exactly this, on fresh data
  _snap := public.support_user_snapshot(_t.user_id);
  _hits := public.support_evaluate_rules(_snap);
  if not exists (select 1 from jsonb_array_elements(_hits) h
                  where h->>'rule' = _p.rule_id and md5((h->>'rule') || ':' || coalesce(h->'args', '{}'::jsonb)::text) = _p.args_hash
                    and (h->>'action') is not distinct from _p.action) then
    update public.support_fix_proposals
       set status = 'superseded', decided_by = _admin, decided_at = now(),
           result = jsonb_build_object('reason', 'the situation changed since the diagnosis'), updated_at = now()
     where id = _proposal;
    return jsonb_build_object('ok', false, 'reason', 'superseded', 'ticket_id', _t.id);
  end if;

  -- act AS the approving admin: auth.uid() = _admin for the wrapped RPCs' guards and their audit rows
  _prev_sub := current_setting('request.jwt.claim.sub', true);
  _prev_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claim.sub', _admin::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  begin
    case _p.action
      when 'assign_group' then
        perform public.admin_assign_group(array[(_p.args->>'user')::uuid], (_p.args->>'group')::uuid);
        _res := jsonb_build_object('group', _p.args->>'group');
      when 'heal_split' then
        _res := public.support_heal_split((_p.args->>'keeper')::uuid, (_p.args->>'twin')::uuid, (_p.args->>'group')::uuid);
      when 'set_account_type' then
        perform public.admin_set_account_type((_p.args->>'user')::uuid, coalesce(_p.args->>'type', 'paid'));
        _res := jsonb_build_object('account_type', coalesce(_p.args->>'type', 'paid'));
      when 'reconcile_points' then
        -- the reconcilers SKIP (returning zeros, like "nothing to award") when their advisory lock is busy: take both
        -- locks here first (xact locks are re-entrant in one transaction) so a busy reconciler is a clean 'failed'
        if not (pg_try_advisory_xact_lock(hashtext('reconcile_challenge_xp'))
                and pg_try_advisory_xact_lock(hashtext('reconcile_challenge_social_xp'))) then
          raise exception 'the points reconciler is running right now — try again in a minute';
        end if;
        select to_jsonb(r) into _rx
          from public.reconcile_challenge_xp((_p.args->>'since')::timestamptz, array[(_p.args->>'user')::uuid]) r;
        select to_jsonb(r) into _rs
          from public.reconcile_challenge_social_xp((_p.args->>'since')::timestamptz, array[(_p.args->>'user')::uuid]) r;
        _res := jsonb_build_object('reconciled_since', _p.args->>'since', 'xp', _rx, 'social', _rs);
      else
        raise exception 'unsupported action %', _p.action;
    end case;
  exception when others then
    _err := left(sqlerrm, 300);
  end;
  perform set_config('request.jwt.claim.sub', coalesce(_prev_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(_prev_claims, ''), true);

  if _err is not null then
    update public.support_fix_proposals
       set status = 'failed', decided_by = _admin, decided_at = now(), result = jsonb_build_object('error', _err), updated_at = now()
     where id = _proposal;
    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (_admin, 'support_fix_failed', _t.user_id, 'support_fix_proposal', null,
            jsonb_build_object('proposal_id', _proposal, 'ticket_id', _t.id, 'rule', _p.rule_id, 'action', _p.action, 'error', _err));
    return jsonb_build_object('ok', false, 'reason', 'failed', 'error', _err, 'ticket_id', _t.id);
  end if;

  -- verify: the rule must no longer fire (a points re-run is verified by having run)
  _hits := public.support_evaluate_rules(public.support_user_snapshot(_t.user_id));
  _verified := _p.action = 'reconcile_points'
               or not exists (select 1 from jsonb_array_elements(_hits) h where h->>'rule' = _p.rule_id);
  _status := case when _verified then 'verified' else 'verify_failed' end;
  update public.support_fix_proposals
     set status = _status, decided_by = _admin, decided_at = now(), result = _res || jsonb_build_object('verified', _verified),
         updated_at = now()
   where id = _proposal;
  insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
  values (_admin, case when _verified then 'support_fix_applied' else 'support_fix_verify_failed' end, _t.user_id,
          'support_fix_proposal', null,
          jsonb_build_object('proposal_id', _proposal, 'ticket_id', _t.id, 'rule', _p.rule_id, 'action', _p.action, 'result', _res));
  return jsonb_build_object('ok', true, 'status', _status, 'action', _p.action, 'result', _res, 'ticket_id', _t.id);
end
$fn$;

revoke execute on function public.support_diag_claim(integer) from public, anon, authenticated;
grant execute on function public.support_diag_claim(integer) to service_role;
revoke execute on function public.support_diag_record(bigint, text, jsonb, jsonb, jsonb, numeric, text) from public, anon, authenticated;
grant execute on function public.support_diag_record(bigint, text, jsonb, jsonb, jsonb, numeric, text) to service_role;
revoke execute on function public.support_proposal_create(bigint, bigint, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.support_proposal_create(bigint, bigint, jsonb, text, text) to service_role;
revoke execute on function public.support_proposal_messages(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.support_proposal_messages(bigint, jsonb) to service_role;
revoke execute on function public.support_ai_call_record(bigint, text, text, integer, integer, numeric, boolean, text) from public, anon, authenticated;
grant execute on function public.support_ai_call_record(bigint, text, text, integer, integer, numeric, boolean, text) to service_role;
revoke execute on function public.support_ai_spent_today() from public, anon, authenticated;
grant execute on function public.support_ai_spent_today() to service_role;
revoke execute on function public.support_proposal_decide(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.support_proposal_decide(bigint, uuid, text) to service_role;
revoke execute on function public.support_proposal_claim_delivery(bigint) from public, anon, authenticated;
grant execute on function public.support_proposal_claim_delivery(bigint) to service_role;
revoke execute on function public.support_proposal_delivered(bigint, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.support_proposal_delivered(bigint, boolean, text, uuid) to service_role;
revoke execute on function public.support_heal_split(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.support_heal_split(uuid, uuid, uuid) to service_role;
revoke execute on function public.support_apply_fix(bigint, uuid) from public, anon, authenticated;
grant execute on function public.support_apply_fix(bigint, uuid) to service_role;

-- ───────────────────────────── the detector ─────────────────────────────
create or replace function public.support_agent_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _stuck int; _late int; _failed int; _unverified int; _undelivered int; _spent numeric;
  _msg text; _tok text; _admin record; _dm int := 0;
  _state jsonb := coalesce((select value from public.app_settings where key = 'support_agent_watchdog_state'), '{}'::jsonb);
  _key text;
  _on boolean;
begin
  -- only what the worker WOULD claim (an open ticket) and only while the agent is on: a ticket an admin answered by
  -- hand leaves its diagnosis queued for ever, and that is not a broken worker
  _on := coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_agent'), false);
  select count(*) into _stuck from public.support_diagnoses d join public.support_tickets t on t.id = d.ticket_id
   where _on and t.status = 'open' and d.status = 'leased' and d.lease_until < now() - interval '10 minutes';
  select count(*) into _late from public.support_diagnoses d join public.support_tickets t on t.id = d.ticket_id
   where _on and t.status = 'open' and d.status = 'queued' and d.created_at < now() - interval '10 minutes';
  select count(*) into _failed from public.support_diagnoses where status = 'failed' and updated_at > now() - interval '24 hours';
  select count(*) into _unverified from public.support_fix_proposals
   where status in ('verify_failed', 'failed') and updated_at > now() - interval '24 hours';
  -- an approved fix/reply whose student message never went out (the bot died between the fix and the send) — not
  -- one the student simply can't receive (delivery_error set: the admin was already told on the card)
  select count(*) into _undelivered from public.support_fix_proposals
   where status in ('verified', 'sent') and delivered_at is null and delivery_error is null
     and decided_at < now() - interval '15 minutes' and decided_at > now() - interval '24 hours';
  _spent := public.support_ai_spent_today();
  _key := concat_ws('|', _stuck > 0, _late > 0, _failed > 0, _unverified > 0, _undelivered > 0);

  if (_stuck + _late + _failed + _unverified + _undelivered) = 0 then
    _state := _state - 'alerted_key' - 'alerted_at';            -- recovered: the next problem alerts at once
  end if;
  if (_stuck + _late + _failed + _unverified + _undelivered) > 0 and _hour between 8 and 21
     and (_state->>'alerted_key' is distinct from _key or (_state->>'alerted_at')::timestamptz < now() - interval '12 hours') then
    _msg := '🤖⚠️ Yordam agenti muammosi:'
            || case when _late > 0 then E'\n• ' || _late || ' ta murojaat 10 daqiqadan beri tahlil qilinmagan (worker ishlamayapti?)' else '' end
            || case when _stuck > 0 then E'\n• ' || _stuck || ' ta tahlil osilib qolgan' else '' end
            || case when _failed > 0 then E'\n• ' || _failed || ' ta tahlil xato bilan tugagan (24 soat)' else '' end
            || case when _unverified > 0 then E'\n• ' || _unverified || ' ta tuzatish bajarilmagan yoki tekshiruvdan oʻtmagan (24 soat)' else '' end
            || case when _undelivered > 0 then E'\n• ' || _undelivered || ' ta tasdiqlangan javob oʻquvchiga yetmagan — kartadagi ✅ ni qayta bosing' else '' end
            || E'\n\nAI xarajati bugun: $' || round(_spent, 3);
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active' limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'support_agent_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
    if _dm > 0 then
      _state := _state || jsonb_build_object('alerted_key', _key, 'alerted_at', now());
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('support_agent_watchdog_state', _state || jsonb_build_object(
    'stuck', _stuck, 'late', _late, 'failed_24h', _failed, 'unverified_24h', _unverified, 'undelivered_24h', _undelivered,
    'ai_spent_today', _spent,
    'dm_attempted', _dm, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('stuck', _stuck, 'late', _late, 'failed', _failed, 'unverified', _unverified,
                            'undelivered', _undelivered, 'dm', _dm);
end
$fn$;

revoke execute on function public.support_agent_watchdog() from public, anon, authenticated;
grant execute on function public.support_agent_watchdog() to service_role;

-- ───────────────────────────── smoke test ─────────────────────────────
-- plpgsql binds lazily: a wrong column or type (the first review of this file found four admin_actions inserts that
-- would have failed at the first admin tap) only shows when the code runs. So the reject, the approve-a-reply, the
-- delivery and the moot-proposal paths run here on fixture rows, inside a block that ALWAYS ends with a sentinel
-- exception — every write (the fixture ticket, the proposals, the audit rows, the agent switched on for one call)
-- rolls back on the success path too. None of these paths takes an advisory lock or needs a JWT (the admin is a
-- parameter); the data actions (assign_group, heal_split, reconcile) are never run here.
do $$
declare
  _admin uuid := (select ur.user_id from public.user_roles ur join public.profiles p on p.id = ur.user_id
                   where ur.role = 'admin' order by ur.user_id limit 1);
  _t bigint;
  _p bigint;
  _r jsonb;
begin
  if _admin is null then
    raise notice 'support executor smoke test skipped: no admin';
    return;
  end if;
  begin
    insert into public.support_tickets (telegram_id, chat_id, locale, status, messages)
    values (-1, -1, 'uz', 'open', '[{"text": "smoke test"}]'::jsonb)
    returning id into _t;

    -- 1. reject
    _p := public.support_proposal_create(_t, null,
            '{"rule": "R99_unknown", "class": "needs_human", "confidence": "low", "args": {}}'::jsonb, 'x', 'proposed');
    _r := public.support_proposal_decide(_p, _admin, 'rejected');
    if not coalesce((_r->>'ok')::boolean, false) then
      raise exception 'ABORT: support_proposal_decide smoke test failed: %', _r;
    end if;

    -- 2. approve a reply (the agent is switched on for this rolled-back block only) → claim → delivered → answered
    update public.platform_settings set value = value || '{"enabled": true, "mode": "propose"}'::jsonb
     where key = 'support_agent';
    _p := public.support_proposal_create(_t, null,
            '{"rule": "R06_dm_blocked", "class": "reply_only", "confidence": "low", "args": {}}'::jsonb, 'y', 'proposed');
    _r := public.support_apply_fix(_p, _admin);
    if _r->>'status' is distinct from 'sent' then
      raise exception 'ABORT: support_apply_fix smoke test failed: %', _r;
    end if;
    if not public.support_proposal_claim_delivery(_p) or public.support_proposal_claim_delivery(_p) then
      raise exception 'ABORT: support_proposal_claim_delivery smoke test failed';
    end if;
    perform public.support_proposal_delivered(_p, true, null, _admin);
    if (select status from public.support_tickets where id = _t) is distinct from 'answered' then
      raise exception 'ABORT: support_proposal_delivered smoke test failed';
    end if;

    -- 3. a proposal on a ticket answered meanwhile is superseded, never executed
    _p := public.support_proposal_create(_t, null,
            '{"rule": "R04_provisional", "class": "data", "confidence": "low", "action": "set_account_type",
              "args": {"user": "00000000-0000-0000-0000-000000000000", "type": "paid"}}'::jsonb, 'z', 'proposed');
    _r := public.support_apply_fix(_p, _admin);
    if _r->>'reason' is distinct from 'ticket_closed' then
      raise exception 'ABORT: support_apply_fix ticket_closed smoke test failed: %', _r;
    end if;

    raise exception 'support_smoke_ok';
  exception when others then
    if sqlerrm <> 'support_smoke_ok' then
      raise;
    end if;
  end;
end $$;

-- ───────────────────────────── crons (no-ops while the agent is off) ─────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'support-agent') then
    perform cron.unschedule('support-agent');
  end if;
  -- the worker is called only when the agent is ON and a diagnosis is waiting: no HTTP traffic while it is off
  perform cron.schedule('support-agent', '* * * * *', $cmd$ select public.ops_net_post(
    'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/support-agent', '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
      'Authorization', 'Bearer ' || public.cron_service_key(), 'x-internal-secret', public.internal_fn_secret()),
    'support-agent', 60000)
   where coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_agent'), false)
     and exists (select 1 from public.support_diagnoses d join public.support_tickets t on t.id = d.ticket_id
                  where t.status = 'open' and d.attempts < 3
                    and (d.status = 'queued' or (d.status = 'leased' and d.lease_until < now()))) $cmd$);
  if exists (select 1 from cron.job where jobname = 'support-agent-watchdog') then
    perform cron.unschedule('support-agent-watchdog');
  end if;
  perform cron.schedule('support-agent-watchdog', '33 * * * *', 'select public.support_agent_watchdog()');
end $$;

