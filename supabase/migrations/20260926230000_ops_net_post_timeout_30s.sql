-- NOISE: ops_net_post's default pg_net wait goes from 5000 ms to 30000 ms.
--
-- WHY (evidence from a read-only investigation, 2026-09-26, after 20260926210000 attributed every
-- SQL-originated HTTP call). ops_http_failure_watchdog records ~132 timeouts a day, clustered at minute
-- :00/:30. They are NOT lost calls, DNS failures or pg_net congestion:
--   * At :00 about 13 calls (9 at :30) hit the edge in the same second; pg_net sends them as one batch
--     and each boots a fresh worker, so run time at :00/:30 is 3-5x the off-peak run time
--     (notify-homework-submission p50 4485 vs 1314 ms, broadcast-drainer 2813 vs 592,
--     notify-badge-award 2650 vs 676).
--   * Anything slower than 5 s is marked timed_out by pg_net — but the edge function keeps running and
--     FINISHES: at 22:00 UTC cron-engagement returned 200 after 7855 ms and canary after 10035 ms,
--     both recorded as timeouts. Every scheduled call reached the edge (24h boots: cron-engagement
--     48/48, canary 96/96, cron-admin-digest 48/48); pg_net never retries, and there were 0 duplicate
--     reminders in 14 days. The "DNS time: 5000" text in the error is misleading — a 2026-09-24 row
--     reading "DNS time: 30000" was a call that ran 38 s and returned 200.
--   * So these timeouts are noise that hides real alarms.
-- THE PRECEDENT: four cron jobs already pass 30000 explicitly (teacher-daily-digest,
-- teacher-engagement-nudge-hourly, bitrix-lead-sync, grade-card-reconcile — "loops over sendMessage
-- could exceed pg_net's 5s default"). grade-card-reconcile ran over 5 s eight times in 24h (max 7961 ms)
-- and produced 0 timeouts. The slowest job still on 5000 peaked at 10035 ms — 3x under 30000.
--
-- WHAT. One change: `p_timeout_ms integer DEFAULT 5000` → `DEFAULT 30000`. Every caller that does not
-- pass p_timeout_ms — the 38 calls converted by 20260926210000 and every future one — waits up to 30 s.
-- Callers that pass it explicitly are unchanged (the four jobs above pass 30000; anon_execute_watchdog
-- passes 5000 for its Telegram DM). Expected: ~90 of the ~132 daily timeouts disappear; what remains
-- is a call that ran over 30 s, which IS a real signal.
-- NOT fixed here: cron-engagement is also being killed by the edge CPU limit in the Tashkent evening
-- window (real missed reminders) — that is a function bug, fixed in its own PR; a longer wait does not
-- touch it.
--
-- TRADE-OFF, accepted: pg_net 0.20 sends one batch at a time, so a hung endpoint can now hold its
-- batch for up to 30 s instead of 5 s before later requests go out. Do not raise it further.
--
-- HOW, and why it is safe. Postgres cannot ALTER a parameter default, so the function is recreated.
-- It is recreated FROM ITS LIVE DEFINITION (never a hand-copied one — the database drifts from the
-- repo), and only if that definition is byte-for-byte the one verified today (md5 pinned below);
-- anything else aborts. The edit is one literal in the header; the body, SECURITY DEFINER,
-- search_path, owner and ACL must all come out unchanged. The self-test reads the catalog only — it
-- never calls ops_net_post, which would send a real HTTP request.
-- Shape stays exactly what lint E9 locks (names, types, order, defaults present).
--
-- IDEMPOTENT + REPLAY-SAFE: if the default is already 30000, it does nothing.

do $mig$
declare
  _fn   regprocedure := to_regprocedure('public.ops_net_post(text,jsonb,jsonb,text,integer)');
  _def  text;
  _new  text;
  _acl  text;
  _owner oid;
begin
  if _fn is null then
    raise exception 'ABORT: public.ops_net_post(text,jsonb,jsonb,text,integer) does not exist';
  end if;

  if pg_get_function_arguments(_fn) like '%p_timeout_ms integer DEFAULT 30000' then
    return;                                                   -- already applied
  end if;

  select pg_get_functiondef(p.oid), coalesce(array_to_string(p.proacl, ','), ''), p.proowner
    into _def, _acl, _owner
  from pg_proc p where p.oid = _fn;

  -- Only the definition verified on 2026-09-26 may be rewritten.
  if md5(_def) <> '5aed494599d0af76f3f1cd0a200f1115' then
    raise exception 'ABORT: ops_net_post changed since it was verified (md5 %); re-read it and regenerate this migration', md5(_def);
  end if;

  _new := replace(_def, 'p_timeout_ms integer DEFAULT 5000)', 'p_timeout_ms integer DEFAULT 30000)');
  if _new = _def or length(_new) - length(_def) <> 1 then
    raise exception 'ABORT: the default literal was not found exactly once';
  end if;

  execute _new;

  -- Post-conditions, from the catalog only.
  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: the stored definition differs from the one executed';
  end if;
  if pg_get_function_arguments(_fn) <> 'p_url text, p_body jsonb DEFAULT ''{}''::jsonb, p_headers jsonb DEFAULT ''{}''::jsonb, p_purpose text DEFAULT NULL::text, p_timeout_ms integer DEFAULT 30000' then
    raise exception 'ABORT: unexpected signature after the change: %', pg_get_function_arguments(_fn);
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or not (select prosecdef from pg_proc where oid = _fn) then
    raise exception 'ABORT: owner, ACL or SECURITY DEFINER changed';
  end if;
  if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
    raise exception 'ABORT: ops_net_post became executable by anon or authenticated';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'ops_net_post_timeout_default_30s',
         jsonb_build_object('from_ms', 5000, 'to_ms', 30000,
                            'why', '~132 timeouts/day were slow-but-successful edge responses at the :00/:30 burst',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'ops_net_post_timeout_default_30s');
end $mig$;
