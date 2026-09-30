-- Challenge 6.0: credit a student's EARLIER group messages when they join the bot (retro credit on link).
--
-- Owner decision (2026-09-30): "credit earlier messages too, when the student joins the bot".
--
-- ═══ THE GAP ═══
-- telegram-bot-webhook stamps group_message_events.profile_id ONCE, at insert, by telegram_id (or by an unclaimed
-- telegram_username). A 6.0 member who posts before pressing Start in the bot gets profile_id NULL on every
-- message, and nothing ever revisits those rows: the challenge engines are arrival-driven -- reconcile_challenge_xp
-- scans webhook_inbox arrivals since its last heartbeat minus 30 min (clamped to 24 h), reconcile_challenge_social_xp
-- advances a cursor over arrivals -- so a message whose sender is linked LATER is behind both scans for good.
-- Two siblings of the same class (found while fanning out; both are fixed by the same path below):
--   * username-stamped rows: a pre-created (intake) profile matched by telegram_username has profile_id on its
--     rows but telegram_id NULL, and challenge_social_source requires s.telegram_id = g.telegram_user_id, so its
--     chat/answer points are never paid; linking telegram_id later makes them payable, behind the cursor.
--   * a student whose group_id changes INTO a challenge group after posting in that group's chat: the
--     engines' current-group gate (g.group_id = sender.group_id) now passes, behind both scans.
-- Measured on production 2026-09-30 15:30 UTC (read-only): 0 rows today (the window opens 2026-10-01 00:00
-- +05, and every 6.0-chat message so far is pre-window); 152 pre-window messages in the 6.0 chats, 138 of them
-- from 60 senders with no profile. Those 60 are exactly who this is for once the window opens.
--
-- ═══ DESIGN: attach, then run the ENGINES THEMSELVES ═══
-- 1. ATTACH (identity only, no scoring): challenge_retro_attach(profile) sets profile_id on the student's own
--    unlinked rows -- same Telegram user id (the verified identity; never a username, which is squattable), same
--    group (g.group_id = the profile's CURRENT group, the engines' gate), same chat (= group_telegram_chat_id(),
--    the platform's existing group->chat primitive), not an anonymous-admin row, sent_at inside challenge.window.
--    Another person's rows, another chat, another group, pre-window and post-window rows are never touched.
--    It also records a ledger row (challenge_retro_credits) with scan_from = the earliest webhook_inbox ARRIVAL
--    among the affected messages (the engines scan arrivals, not send times).
-- 2. CREDIT (scoring = the engines, unmodified): challenge_retro_credit_run() takes BOTH engines' own try-locks
--    (re-entrant in this session), then calls reconcile_challenge_xp(scan_from) and
--    reconcile_challenge_social_xp(scan_from) -- their documented explicit back-fill mode -- so media (+5, 3/day),
--    chat (+1, 5 POINTS/day) and answer candidates are decided by exactly the live rules, caps are counted per
--    HISTORIC Tashkent day (every award is written with created_at = sent_at), and UNIQUE(user_id, ref_key) plus
--    the shared locks make a second payment impossible whichever of the live ticks and this run comes first.
--    No scoring logic is duplicated here and NO existing function is rewritten (nothing to conflict with the
--    in-flight Daily Tasks engine branch). The explicit runs scan every scope group from the earliest pending
--    arrival to now, bounded by the window and scope; for everyone else that is a no-op re-check (idempotent).
--    Answers: the enqueue re-derives eligibility in BOTH directions -- the late student's replies to a linked
--    classmate AND a linked classmate's earlier replies to the late student's questions (the asker had no
--    profile then, so that reply was never a candidate). Candidates are then judged by challenge-qa-judge like
--    any other (they share its daily call budget, 600; per-answerer-day judge caps still apply) and paid by
--    challenge_qa_apply with the historic answer_sent_at.
--    The two engine heartbeats an explicit run writes are RE-LABELLED 'challenge_retro_engine_heartbeat' (details
--    kept, plus 'relabelled_from'), because they are not cron ticks: left as-is they would stand in for a dead
--    cron in challenge_xp_watchdog (1 h) and challenge_social_watchdog A1 (40 min) during an onboarding wave.
--    Engine state is unaffected: the media lookback reads the last REAL tick (this run scanned a superset), and
--    the social explicit mode never moves the cursor.
-- 3. INSTANT PATH + RECONCILER: trg_profiles_challenge_retro_credit (AFTER INSERT OR UPDATE OF telegram_id,
--    group_id ON profiles) attaches at link time on EVERY link path (bot /start, username link, web login,
--    admin-create-students, Mini App auth, identity sweeps) -- it only acts when telegram_id or group_id actually
--    changed, and it can never fail the profile write (errors -> admin_actions 'challenge_retro_link_error').
--    The cron sweep (every 10 min at :08) re-derives the attach set-based for anything the trigger missed and
--    credits the pending ledger. Only the trigger can see the username/group-move siblings (their rows are not
--    NULL), so it records them as 'relinked'.
--
-- ═══ STATES ═══
-- challenge_retro_credits.status: pending -> credited (both engines ran without a section error) | expired (window
-- ended > 24 h ago, past the engines' W2 tail) | nothing_to_credit (attached rows have no webhook_inbox row: no
-- engine can pay them). A lock miss ('locked') or an inactive challenge ('deferred_inactive') leaves rows pending
-- WITHOUT using an attempt; an engine error uses one; at retro_credit.max_attempts (6) a row stops retrying and
-- alarms (R2). 'expired' is terminal. Recovery after the cause is fixed:
--   update public.challenge_retro_credits set attempts = 0, last_error = null where status = 'pending';
-- Manual re-credit from a point in time (after a kill-switch period, a re-opened window, ...): the next sweep runs
-- both engines from it, idempotently:
--   insert into public.challenge_retro_credits (source, scan_from) values ('heal', '<timestamptz>');
-- Frozen weeks: a late student's points land on their historic days, which can be inside a week whose prize table
-- (challenge_weekly_results, frozen Monday 09:10 Tashkent) is already final. The frozen table is NOT touched --
-- prizes stay as decided -- and the run counts such points ('into_frozen_weeks' in its heartbeat and ledger row,
-- summed in health). Re-freezing a week stays a deliberate admin act: select public.freeze_challenge_week('<monday>');
-- History heal: if the window is already open when this file lands, ONE 'heal' row (scan_from = window.start -
-- 5 min) makes the first sweep re-run both engines from the start, which also pays the two siblings above for
-- anyone linked before the trigger existed. Applied before the window opens (the expected case) it adds nothing.
--
-- ═══ KILL-SWITCHES (no deploy) ═══
--   challenge.retro_credit.enabled=false ... no attach, no credit (trigger + sweep report 'off')
--   challenge.enabled=false ............... attach continues, credit waits ('deferred_inactive'), pays on re-enable
--   last resort: cron.unschedule('challenge-retro-credit') / alter table profiles disable trigger
--                trg_profiles_challenge_retro_credit
-- A missing/malformed retro_credit key FAILS CLOSED (off) and alarms (R4); so does a window with no start.
--
-- ═══ DETECTORS ═══
-- challenge_retro_credit_health() (service_role) and challenge_retro_credit_watchdog() (hourly :57, DMs up to 3
-- admins through ops_net_post, latched in app_settings 'challenge_retro_credit_watchdog_state' which stamps
-- checked_at every run). Alarms while the challenge is active or in its tail: R1 sweep silent 30 min / cron job
-- or trigger missing; R2 a pending row stuck (max attempts) or older than 60 min; R3 unlinked rows of a sender
-- linked > 20 min ago still unattached, a trigger error in 2 h, or a sweep attach error; R4 invalid config or a
-- scope group whose chat cannot be derived.
-- Every run writes admin_actions 'challenge_retro_credit_run' {status, attached, credited, engine results}.
--
-- NOT MODIFIED: reconcile_challenge_xp, reconcile_challenge_social_xp, challenge_social_source,
-- challenge_qa_enqueue_range, challenge_qa_apply, reconcile_community_xp (in scope groups inside the window the
-- community engine already skips these rows via challenge_social_owns_community), telegram-bot-webhook.
-- NOT DONE (outside the owner's decision, reported instead): the same class exists in 5.0 -- 466 unlinked rows from
-- 72 senders who are linked today, all 2026-07-07..08-25 -- where the community engine's 2 h lookback never
-- revisited them. Attaching them would change 5.0 analytics and community XP; it needs its own decision.
-- Answer points pay only in qa.mode='live' (today 'shadow'): retro candidates follow the same mode.
--
-- SELF-TEST: non-mutating -- config parse, object/RLS/ACL/trigger/index/cron presence, health() runs. It never
-- calls the attach, the sweep (it takes the engines' locks and pays real points) or the watchdog, sends nothing
-- and needs no JWT.
-- PGlite harness: supabase/functions/_challenge/testing/retro-credit-check.ts applies this file on the LIVE engine
-- bodies (md5-verified against production) and proves: late-link credit == linked-from-the-start credit (same
-- ref_keys, amounts and historic created_at), caps per historic day, isolation, idempotency, no double pay with
-- interleaved live ticks, the username and group-move siblings, kill-switches, expiry, error retry, detectors.

-- ═══════════════════════════════ 1. Config (existing values win) ═══════════════════════════════
update public.platform_settings
   set value = value || jsonb_build_object('retro_credit',
         jsonb_build_object('enabled', true, 'max_attempts', 6)
         || coalesce(case when jsonb_typeof(value->'retro_credit') = 'object' then value->'retro_credit' end, '{}'::jsonb))
 where key = 'challenge';

-- ═══════════════════════════════ 2. Index: a sender's UNLINKED rows ═══════════════════════════════
-- Partial: only profile_id IS NULL rows (~1.1k today), so the attach and the sweep never scan linked history.
create index if not exists idx_gme_unlinked_sender
  on public.group_message_events (telegram_user_id, group_id)
  where profile_id is null;

-- ═══════════════════════════════ 3. Ledger ═══════════════════════════════
create table if not exists public.challenge_retro_credits (
  id bigint generated always as identity primary key,
  source text not null check (source in ('link_trigger', 'sweep', 'heal')),
  profile_id uuid references public.profiles(id) on delete cascade,
  group_id uuid,
  telegram_user_id bigint,
  attached integer not null default 0 check (attached >= 0),        -- rows whose profile_id this run set
  relinked integer not null default 0 check (relinked >= 0),        -- rows already stamped to the profile that a
                                                                     -- telegram_id / group_id change made payable
  without_inbox integer not null default 0 check (without_inbox >= 0), -- affected rows no engine can see
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  scan_from timestamptz,                                             -- earliest webhook_inbox arrival affected
  status text not null default 'pending'
    check (status in ('pending', 'credited', 'expired', 'nothing_to_credit')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  credited_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  result jsonb,
  created_at timestamptz not null default now(),
  constraint challenge_retro_credits_identity check (source = 'heal' or (profile_id is not null and telegram_user_id is not null)),
  constraint challenge_retro_credits_pending_scan check (status <> 'pending' or scan_from is not null)
);
create index if not exists idx_challenge_retro_credits_pending on public.challenge_retro_credits (created_at)
  where status = 'pending';
create index if not exists idx_challenge_retro_credits_profile on public.challenge_retro_credits (profile_id);
comment on table public.challenge_retro_credits is
  'Challenge retro credit ledger: one row per attach (link trigger / sweep) or heal; the sweep credits pending rows by running the challenge engines from scan_from. Service-role only.';

alter table public.challenge_retro_credits enable row level security;
revoke all on table public.challenge_retro_credits from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_retro_credits to service_role;
do $$
declare _s text := pg_get_serial_sequence('public.challenge_retro_credits', 'id');
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', _s);
  execute format('grant usage, select on sequence %s to service_role', _s);
end $$;

-- ═══════════════════════════════ 4. Config parser ═══════════════════════════════
-- NEW signal, FAILS CLOSED: an absent/non-boolean retro_credit.enabled is OFF and listed in `invalid`; the window
-- is the W1 parse of reconcile_challenge_xp, and a window with no start attaches nothing (win_bad).
create or replace function public.challenge_retro_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  _c jsonb;
  _inv text[] := '{}';
  _on boolean := false;
  _max int;
  _w_start timestamptz; _w_end timestamptz; _win_bad boolean := false;
begin
  _c := coalesce(public.challenge_config(), '{}'::jsonb);
  if jsonb_typeof(_c) <> 'object' then _c := '{}'::jsonb; end if;

  if jsonb_typeof(_c->'retro_credit'->'enabled') = 'boolean' then
    _on := (_c->'retro_credit'->>'enabled')::boolean;
  else
    _inv := array_append(_inv, 'retro_credit.enabled');
  end if;
  _max := public.challenge_cfg_int(_c->'retro_credit'->'max_attempts');
  if _max is null or _max <= 0 then
    _inv := array_append(_inv, 'retro_credit.max_attempts');
    _max := 6;
  end if;

  begin
    _w_start := nullif(_c->'window'->>'start', '')::timestamptz;
  exception when others then _w_start := null; _win_bad := true;
  end;
  begin
    _w_end := nullif(_c->'window'->>'end', '')::timestamptz;
  exception when others then _w_end := null; _win_bad := true;
  end;
  if _w_start is null then _win_bad := true; end if;

  return jsonb_build_object('enabled', _on, 'max_attempts', _max, 'w_start', _w_start, 'w_end', _w_end,
                            'win_bad', _win_bad, 'invalid', to_jsonb(_inv));
exception when others then
  return jsonb_build_object('enabled', false, 'max_attempts', 6, 'w_start', null, 'w_end', null, 'win_bad', true,
                            'invalid', jsonb_build_array('config_parse_error'));
end
$fn$;

-- ═══════════════════════════════ 5. Attach (identity only) ═══════════════════════════════
-- ONE code path for the link trigger and the sweep. Returns {status, attached, relinked, scan_from, ledger_id}.
-- 'relinked' (link_trigger only): the profile's OWN earlier rows in its current group chat inside the window
-- that a telegram_id/group_id change just made payable (username-stamped or group-move rows).
create or replace function public.challenge_retro_attach(_profile uuid, _source text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _cfg jsonb := public.challenge_retro_config();
  _w_start timestamptz; _w_end timestamptz;
  _p record;
  _chat bigint;
  _att int := 0; _rel int := 0; _noin int := 0;
  _first timestamptz; _last timestamptz; _scan timestamptz;
  _id bigint;
begin
  if _source is null or _source not in ('link_trigger', 'sweep') then
    raise exception 'challenge_retro_attach: unknown source %', _source;
  end if;
  if not coalesce((_cfg->>'enabled')::boolean, false) then
    return jsonb_build_object('status', 'off');
  end if;
  if coalesce((_cfg->>'win_bad')::boolean, true) then
    return jsonb_build_object('status', 'window_invalid');
  end if;
  _w_start := (_cfg->>'w_start')::timestamptz;
  _w_end := (_cfg->>'w_end')::timestamptz;

  select p.id, p.telegram_id, p.group_id into _p from public.profiles p where p.id = _profile;
  if not found or _p.telegram_id is null or _p.group_id is null then
    return jsonb_build_object('status', 'not_linked');
  end if;
  if not exists (select 1 from public.challenge_scope_group_ids() s(id) where s.id = _p.group_id) then
    return jsonb_build_object('status', 'out_of_scope');
  end if;
  _chat := public.group_telegram_chat_id(_p.group_id);
  if _chat is null then
    return jsonb_build_object('status', 'no_group_chat');
  end if;

  with att as (
    update public.group_message_events g
       set profile_id = _p.id
     where g.profile_id is null
       and g.telegram_user_id = _p.telegram_id           -- the verified Telegram identity, never a username
       and g.group_id = _p.group_id                       -- the student's CURRENT group (the engines' gate)
       and g.telegram_chat_id = _chat                     -- ... and that group's chat
       and not coalesce(g.is_anon_admin, false)
       and g.sent_at >= _w_start
       and (_w_end is null or g.sent_at <= _w_end)
    returning g.telegram_chat_id as chat, g.telegram_message_id as msg, g.sent_at, 'a'::text as k
  ),
  rel as (
    -- Evaluated on the statement snapshot, so it never sees the rows `att` is updating: disjoint by construction.
    select g.telegram_chat_id as chat, g.telegram_message_id as msg, g.sent_at, 'r'::text as k
      from public.group_message_events g
     where _source = 'link_trigger'
       and g.profile_id = _p.id
       and g.telegram_user_id = _p.telegram_id
       and g.group_id = _p.group_id
       and g.telegram_chat_id = _chat
       and not coalesce(g.is_anon_admin, false)
       and g.sent_at >= _w_start
       and (_w_end is null or g.sent_at <= _w_end)
  ),
  x as (
    select u.*, (select min(w.received_at) from public.webhook_inbox w
                  where w.chat_id = u.chat and w.message_id = u.msg and w.update_type = 'message') as arrived
      from (select * from att union all select * from rel) u
  )
  select count(*) filter (where x.k = 'a'), count(*) filter (where x.k = 'r'),
         count(*) filter (where x.arrived is null),
         min(x.sent_at), max(x.sent_at), min(x.arrived)
    into _att, _rel, _noin, _first, _last, _scan
    from x;

  if _att + _rel = 0 then
    return jsonb_build_object('status', 'nothing', 'attached', 0, 'relinked', 0);
  end if;

  insert into public.challenge_retro_credits
    (source, profile_id, group_id, telegram_user_id, attached, relinked, without_inbox, first_sent_at, last_sent_at,
     scan_from, status)
  values (_source, _p.id, _p.group_id, _p.telegram_id, _att, _rel, _noin, _first, _last, _scan,
          case when _scan is null then 'nothing_to_credit' else 'pending' end)
  returning id into _id;

  return jsonb_build_object('status', 'attached', 'attached', _att, 'relinked', _rel, 'without_inbox', _noin,
                            'scan_from', _scan, 'ledger_id', _id);
end
$fn$;

-- ═══════════════════════════════ 6. The instant path: link trigger ═══════════════════════════════
create or replace function public.challenge_retro_on_profile_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.telegram_id is null or new.group_id is null then
    return null;
  end if;
  -- UPDATE OF fires whenever the column is in the SET list; act only on a real change.
  if tg_op = 'UPDATE' and new.telegram_id is not distinct from old.telegram_id
     and new.group_id is not distinct from old.group_id then
    return null;
  end if;
  begin
    perform public.challenge_retro_attach(new.id, 'link_trigger');
  exception when others then
    -- Never fail the profile write (a login, a /start, an intake). The sweep re-derives the attach; this row is
    -- the signal (watchdog R3).
    begin
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      values (null, 'challenge_retro_link_error', new.id,
              jsonb_build_object('op', tg_op, 'error', left(sqlerrm, 300), 'sqlstate', sqlstate, 'at', now()));
    exception when others then null;
    end;
  end;
  return null;
end
$fn$;

drop trigger if exists trg_profiles_challenge_retro_credit on public.profiles;
create trigger trg_profiles_challenge_retro_credit
  after insert or update of telegram_id, group_id on public.profiles
  for each row
  when (new.telegram_id is not null and new.group_id is not null)
  execute function public.challenge_retro_on_profile_link();

-- ═══════════════════════════════ 7. The sweep: re-derive the attach, credit through the engines ═══════════════════════════════
create or replace function public.challenge_retro_credit_run()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _cfg jsonb := public.challenge_retro_config();
  _on boolean := coalesce((_cfg->>'enabled')::boolean, false);
  _max int := coalesce((_cfg->>'max_attempts')::int, 6);
  _win_bad boolean := coalesce((_cfg->>'win_bad')::boolean, true);
  _w_start timestamptz := (_cfg->>'w_start')::timestamptz;
  _w_end timestamptz := (_cfg->>'w_end')::timestamptz;
  _active boolean := public.challenge_active();
  _tail boolean := false;
  _p record; _r jsonb;
  _att_profiles int := 0; _att_rows int := 0; _att_errs int := 0; _att_err text;
  _ids bigint[]; _from timestamptz; _n int := 0; _expired int := 0;
  _locked boolean := false;
  _m_aw int; _m_cp int; _s_chat int; _s_enq int; _s_app int;
  _mhb jsonb; _shb jsonb;
  _frozen_to timestamptz; _frozen_before bigint; _frozen_after bigint; _into_frozen int;
  _err text; _status text;
  _report jsonb;
begin
  _tail := not _active and not _win_bad and _w_end is not null
           and now() > _w_end and _w_end >= now() - interval '24 hours'
           and public.challenge_active(_w_end);

  if not _on then
    _status := 'off';
  else
    -- 1. ATTACH, set-based: every unlinked in-window row of a scope group whose sender now has a profile in that
    --    group, posted in that group's chat. The same function the trigger calls; bounded per run.
    if not _win_bad then
      for _p in
        with sc as (
          select s.id, public.group_telegram_chat_id(s.id) as chat from public.challenge_scope_group_ids() s(id)
        )
        select distinct p.id
          from public.group_message_events g
          join sc on sc.id = g.group_id and sc.chat = g.telegram_chat_id
          join public.profiles p on p.telegram_id = g.telegram_user_id and p.group_id = g.group_id
         where g.profile_id is null
           and not coalesce(g.is_anon_admin, false)
           and g.sent_at >= _w_start
           and (_w_end is null or g.sent_at <= _w_end)
         limit 500
      loop
        begin
          _r := public.challenge_retro_attach(_p.id, 'sweep');
          if _r->>'status' = 'attached' then
            _att_profiles := _att_profiles + 1;
            _att_rows := _att_rows + coalesce((_r->>'attached')::int, 0);
          end if;
        exception when others then
          _att_errs := _att_errs + 1;
          _att_err := left(sqlerrm, 300);
        end;
      end loop;
    end if;

    -- 2. CREDIT every pending row in ONE pass of each engine, from the earliest pending arrival.
    select array_agg(c.id order by c.id), min(c.scan_from), count(*)
      into _ids, _from, _n
      from public.challenge_retro_credits c
     where c.status = 'pending' and c.attempts < _max;

    if _ids is null then
      _status := 'idle';
    elsif not (_active or _tail) then
      if not _win_bad and _w_end is not null and now() > _w_end + interval '24 hours' then
        -- Past the engines' W2 tail: nothing can pay any more. Closed, visibly.
        update public.challenge_retro_credits
           set status = 'expired', last_attempt_at = now(), last_error = 'window_ended'
         where id = any(_ids) and status = 'pending';
        get diagnostics _expired = row_count;
        _status := 'expired';
      else
        _status := 'deferred_inactive';   -- challenge.enabled=false: wait, no attempt used
      end if;
    else
      -- The engines' OWN try-locks, taken by THIS session: each engine's try-lock below then succeeds (advisory
      -- locks are re-entrant per session) and no live tick can interleave with this run.
      _locked := not pg_try_advisory_xact_lock(hashtext('reconcile_challenge_xp'));
      if not _locked then
        _locked := not pg_try_advisory_xact_lock(hashtext('reconcile_challenge_social_xp'));
      end if;
    end if;

    if _ids is not null and (_active or _tail) and _locked then
      _status := 'locked';                -- a live tick is running: retry next run, no attempt used
    elsif _ids is not null and (_active or _tail) then
      -- Points landing in a week whose prize table is already frozen: counted, not blocked (see header).
      select (max(r.week_start) + 7)::timestamp at time zone 'Asia/Tashkent' into _frozen_to
        from public.challenge_weekly_results r;
      if _frozen_to is not null then
        select count(*) into _frozen_before from public.xp_events x
         where x.reason in ('challenge_group_media', 'challenge_chat', 'challenge_answer')
           and x.created_at >= _w_start and x.created_at < _frozen_to;
      end if;

      -- Each engine in its own sub-block: an error rolls back only that engine's work.
      begin
        select e.awarded, e.capped into _m_aw, _m_cp from public.reconcile_challenge_xp(_from) e;
        select a.details into _mhb from public.admin_actions a
         where a.action = 'challenge_xp_reconciled' and a.created_at = now()
         limit 1;
        update public.admin_actions a
           set action = 'challenge_retro_engine_heartbeat',
               details = a.details || jsonb_build_object('relabelled_from', 'challenge_xp_reconciled')
         where a.action = 'challenge_xp_reconciled' and a.created_at = now();
      exception when others then
        _err := 'media: ' || left(sqlerrm, 200);
      end;
      begin
        select e.chat_awarded, e.qa_enqueued, e.qa_applied into _s_chat, _s_enq, _s_app
          from public.reconcile_challenge_social_xp(_from) e;
        select a.details into _shb from public.admin_actions a
         where a.action = 'challenge_social_reconciled' and a.created_at = now()
           and coalesce((a.details->>'explicit')::boolean, false)
         limit 1;
        update public.admin_actions a
           set action = 'challenge_retro_engine_heartbeat',
               details = a.details || jsonb_build_object('relabelled_from', 'challenge_social_reconciled')
         where a.action = 'challenge_social_reconciled' and a.created_at = now()
           and coalesce((a.details->>'explicit')::boolean, false);
        -- The social engine swallows a section error into its heartbeat (and rolls that section back): read it.
        if _shb is null then
          _err := concat_ws('; ', _err, 'social: heartbeat missing');
        elsif (_shb->>'chat_error') is not null or (_shb->>'qa_error') is not null then
          _err := concat_ws('; ', _err, 'social: ' || left(concat_ws(' | ', _shb->>'chat_error', _shb->>'qa_error'), 200));
        end if;
      exception when others then
        _err := concat_ws('; ', _err, 'social: ' || left(sqlerrm, 200));
      end;

      if _frozen_to is not null then
        select count(*) into _frozen_after from public.xp_events x
         where x.reason in ('challenge_group_media', 'challenge_chat', 'challenge_answer')
           and x.created_at >= _w_start and x.created_at < _frozen_to;
        _into_frozen := (_frozen_after - _frozen_before)::int;
      end if;

      if _err is null then
        update public.challenge_retro_credits
           set status = 'credited', credited_at = now(), last_attempt_at = now(), attempts = attempts + 1,
               last_error = null,
               result = jsonb_build_object('scan_from', _from, 'batch', _n,
                          'media_awarded', _m_aw, 'media_capped', _m_cp, 'chat_awarded', _s_chat,
                          'qa_enqueued', _s_enq, 'qa_applied', _s_app, 'into_frozen_weeks', _into_frozen)
         where id = any(_ids) and status = 'pending';
        _status := 'credited';
      else
        update public.challenge_retro_credits
           set attempts = attempts + 1, last_attempt_at = now(), last_error = left(_err, 500)
         where id = any(_ids) and status = 'pending';
        _status := 'error';
      end if;
    end if;
  end if;

  _report := jsonb_build_object(
    'status', _status, 'enabled', _on, 'active', _active, 'tail', _tail, 'window_invalid', _win_bad,
    'config_invalid', coalesce(_cfg->'invalid', '[]'::jsonb),
    'attached_profiles', _att_profiles, 'attached_rows', _att_rows, 'attach_errors', _att_errs, 'attach_error', _att_err,
    'batch', coalesce(_n, 0), 'scan_from', _from, 'expired', _expired,
    'media_awarded', _m_aw, 'media_capped', _m_cp, 'chat_awarded', _s_chat, 'qa_enqueued', _s_enq, 'qa_applied', _s_app,
    'into_frozen_weeks', _into_frozen, 'social_heartbeat', _shb, 'media_heartbeat', _mhb, 'error', _err, 'at', now());
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_retro_credit_run', _report);
  exception when others then null;
  end;
  return _report;
end
$fn$;

-- ═══════════════════════════════ 8. Health (read-only) ═══════════════════════════════
create or replace function public.challenge_retro_credit_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  _cfg jsonb := public.challenge_retro_config();
  _max int := coalesce((_cfg->>'max_attempts')::int, 6);
  _win_bad boolean := coalesce((_cfg->>'win_bad')::boolean, true);
  _w_start timestamptz := (_cfg->>'w_start')::timestamptz;
  _w_end timestamptz := (_cfg->>'w_end')::timestamptz;
  _hb record; _q record; _un record;
begin
  select a.created_at, a.details into _hb from public.admin_actions a
   where a.action = 'challenge_retro_credit_run' order by a.created_at desc limit 1;

  select count(*) filter (where c.status = 'pending') as pending,
         count(*) filter (where c.status = 'pending' and c.attempts >= _max) as stuck,
         round(coalesce(max(extract(epoch from now() - c.created_at) / 60) filter (where c.status = 'pending'), 0)) as oldest_min,
         max(c.last_error) filter (where c.status = 'pending') as last_error,
         count(*) filter (where c.status = 'credited' and c.credited_at > now() - interval '7 days') as credited_7d,
         coalesce(sum(c.attached + c.relinked) filter (where c.status = 'credited' and c.credited_at > now() - interval '7 days'), 0) as credited_rows_7d,
         count(distinct c.profile_id) filter (where c.status = 'credited' and c.credited_at > now() - interval '7 days') as credited_profiles_7d,
         count(*) filter (where c.status = 'expired' and c.last_attempt_at > now() - interval '7 days') as expired_7d,
         count(*) filter (where c.status = 'nothing_to_credit' and c.created_at > now() - interval '7 days') as nothing_to_credit_7d,
         coalesce(sum(case when c.status = 'credited' and c.credited_at > now() - interval '7 days'
                                and jsonb_typeof(c.result->'into_frozen_weeks') = 'number'
                           then (c.result->>'into_frozen_weeks')::int end), 0) as into_frozen_7d
    into _q
    from public.challenge_retro_credits c;

  -- Rows the trigger or the sweep should already have attached (sender linked in that group > 20 min ago).
  if not _win_bad then
    with sc as (
      select s.id, public.group_telegram_chat_id(s.id) as chat from public.challenge_scope_group_ids() s(id)
    )
    select count(*) as n, count(distinct g.telegram_user_id) as senders, min(g.sent_at) as oldest
      into _un
      from public.group_message_events g
      join sc on sc.id = g.group_id and sc.chat = g.telegram_chat_id
      join public.profiles p on p.telegram_id = g.telegram_user_id and p.group_id = g.group_id
     where g.profile_id is null
       and not coalesce(g.is_anon_admin, false)
       and g.sent_at >= _w_start
       and (_w_end is null or g.sent_at <= _w_end)
       and p.updated_at < now() - interval '20 minutes';
  end if;

  return jsonb_build_object(
    'config', _cfg,
    'active', public.challenge_active(),
    'last_run', jsonb_build_object('at', _hb.created_at, 'status', _hb.details->>'status',
                                   'error', _hb.details->'error', 'attach_errors', coalesce((_hb.details->>'attach_errors')::int, 0)),
    'runs_24h', coalesce((select jsonb_object_agg(z.st, z.n) from (
        select a.details->>'status' as st, count(*) as n from public.admin_actions a
         where a.action = 'challenge_retro_credit_run' and a.created_at > now() - interval '24 hours'
         group by 1) z), '{}'::jsonb),
    'queue', jsonb_build_object('pending', _q.pending, 'stuck', _q.stuck, 'oldest_pending_minutes', _q.oldest_min,
                                'last_error', _q.last_error, 'credited_7d', _q.credited_7d,
                                'credited_rows_7d', _q.credited_rows_7d, 'credited_profiles_7d', _q.credited_profiles_7d,
                                'expired_7d', _q.expired_7d, 'nothing_to_credit_7d', _q.nothing_to_credit_7d,
                                'into_frozen_weeks_7d', _q.into_frozen_7d),
    'unattached', jsonb_build_object('rows', coalesce(_un.n, 0), 'senders', coalesce(_un.senders, 0), 'oldest_sent_at', _un.oldest),
    'link_errors_24h', (select count(*) from public.admin_actions a
                         where a.action = 'challenge_retro_link_error' and a.created_at > now() - interval '24 hours'),
    'link_errors_2h', (select count(*) from public.admin_actions a
                        where a.action = 'challenge_retro_link_error' and a.created_at > now() - interval '2 hours'),
    'scope_groups_without_chat', (select count(*) from public.challenge_scope_group_ids() s(id)
                                   where public.group_telegram_chat_id(s.id) is null),
    'trigger_enabled', exists (select 1 from pg_trigger t
                                where t.tgrelid = 'public.profiles'::regclass
                                  and t.tgname = 'trg_profiles_challenge_retro_credit' and t.tgenabled <> 'D'),
    'cron_active', (select count(*) from cron.job j
                     where j.active and j.jobname in ('challenge-retro-credit', 'challenge-retro-credit-watchdog')) = 2,
    'checked_at', now());
end
$fn$;

-- ═══════════════════════════════ 9. Watchdog (hourly, DMs admins) ═══════════════════════════════
create or replace function public.challenge_retro_credit_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _cfg jsonb := public.challenge_retro_config();
  _active boolean := public.challenge_active();
  _w_end timestamptz := (_cfg->>'w_end')::timestamptz;
  _tail boolean;
  _h jsonb;
  _alarms text[] := '{}'; _msgs text[] := '{}';
  _state jsonb; _alerting boolean; _last_ms bigint; _notified boolean; _clean int; _prev text[];
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _send boolean := false; _recover boolean := false; _sent int := 0;
  _tok text; _admin record; _msg text; _report jsonb;
begin
  select value into _state from public.app_settings where key = 'challenge_retro_credit_watchdog_state';
  _state := coalesce(_state, '{}'::jsonb);

  _tail := not _active and not coalesce((_cfg->>'win_bad')::boolean, true) and _w_end is not null
           and now() > _w_end and _w_end >= now() - interval '24 hours' and public.challenge_active(_w_end);

  if not (_active or _tail) then
    _report := jsonb_build_object('state', 'inactive', 'at', now());
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_retro_credit_watchdog_report', _report);
    exception when others then null; end;
    insert into public.app_settings (key, value)
    values ('challenge_retro_credit_watchdog_state', _state || jsonb_build_object('checked_at', now(), 'last_state', 'inactive'))
    on conflict (key) do update set value = excluded.value, updated_at = now();
    return _report;
  end if;

  begin
    _h := public.challenge_retro_credit_health();
  exception when others then
    _h := null;
    _alarms := array_append(_alarms, 'R0');
    _msgs := array_append(_msgs, 'challenge_retro_credit_health() xato berdi: ' || left(sqlerrm, 120));
  end;

  if _h is not null then
    -- R1: the sweep is silent, or its cron job / the link trigger is gone
    if (_h#>>'{last_run,at}') is null or (_h#>>'{last_run,at}')::timestamptz < now() - interval '30 minutes'
       or not coalesce((_h->>'cron_active')::boolean, false)
       or not coalesce((_h->>'trigger_enabled')::boolean, false) then
      _alarms := array_append(_alarms, 'R1');
      _msgs := array_append(_msgs, 'Kechikkan ballar hisoblagichi ishlamayapti (oxirgi yurish: '
                                  || coalesce(_h#>>'{last_run,at}', 'hech qachon') || ', cron: '
                                  || coalesce(_h->>'cron_active', '?') || ', trigger: '
                                  || coalesce(_h->>'trigger_enabled', '?') || ').');
    end if;

    -- R2: credit is stuck (max attempts) or waiting too long (locks / errors); not while deliberately switched off
    if coalesce((_h#>>'{queue,stuck}')::int, 0) > 0
       or (coalesce((_h#>>'{config,enabled}')::boolean, false)
           and coalesce((_h#>>'{queue,pending}')::int, 0) > 0
           and coalesce((_h#>>'{queue,oldest_pending_minutes}')::numeric, 0) > 60) then
      _alarms := array_append(_alarms, 'R2');
      _msgs := array_append(_msgs, 'Kechikkan ballar navbati tiqilib qoldi: ' || coalesce(_h#>>'{queue,pending}', '0')
                                  || ' ta yozuv, eng eskisi ' || coalesce(_h#>>'{queue,oldest_pending_minutes}', '0')
                                  || ' daqiqa, oxirgi xato: ' || coalesce(left(_h#>>'{queue,last_error}', 150), '-') || '.');
    end if;

    -- R3: rows of an already-linked student left unattached, a link-trigger error in the last 2 h (the hourly run
    -- sees each one; a healed transient error stops alarming), or an attach error in the last sweep
    if coalesce((_h#>>'{unattached,rows}')::int, 0) > 0
       or coalesce((_h->>'link_errors_2h')::int, 0) > 0
       or coalesce((_h#>>'{last_run,attach_errors}')::int, 0) > 0 then
      _alarms := array_append(_alarms, 'R3');
      _msgs := array_append(_msgs, coalesce(_h#>>'{unattached,rows}', '0') || ' ta xabar egasiga biriktirilmadi ('
                                  || coalesce(_h#>>'{unattached,senders}', '0') || ' oʻquvchi botga ulangan), trigger xatolari (2 soat): '
                                  || coalesce(_h->>'link_errors_2h', '0') || ', oxirgi yurishdagi xatolar: '
                                  || coalesce(_h#>>'{last_run,attach_errors}', '0') || '.');
    end if;

    -- R4: a hand-edit broke the config (the feature is OFF until fixed), or a scope group has no chat
    if jsonb_array_length(coalesce(_h#>'{config,invalid}', '[]'::jsonb)) > 0
       or coalesce((_h#>>'{config,win_bad}')::boolean, false)
       or coalesce((_h->>'scope_groups_without_chat')::int, 0) > 0 then
      _alarms := array_append(_alarms, 'R4');
      _msgs := array_append(_msgs, 'platform_settings.challenge.retro_credit / window notoʻgʻri yoki guruh chati topilmadi: '
                                  || coalesce((_h#>'{config,invalid}')::text, '[]')
                                  || case when coalesce((_h#>>'{config,win_bad}')::boolean, false) then ' (window)' else '' end
                                  || ', chatsiz guruhlar: ' || coalesce(_h->>'scope_groups_without_chat', '0') || '.');
    end if;
  end if;

  -- Latch (as challenge_social_watchdog): DM on a new breach, every 11.5 h while breached; recovery only after
  -- 2 clean runs AND only if an alert of this episode actually went out.
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms := coalesce((_state->>'last_alert_ms')::bigint, 0);
  _notified := coalesce((_state->>'notified')::boolean, false);
  _clean := coalesce((_state->>'clean_runs')::int, 0);
  select coalesce(array_agg(x), '{}') into _prev
    from jsonb_array_elements_text(case when jsonb_typeof(_state->'alarms') = 'array' then _state->'alarms' else '[]'::jsonb end) x;

  if cardinality(_alarms) > 0 then
    _clean := 0;
    if not _alerting or exists (select 1 from unnest(_alarms) a where not (a = any(_prev)))
       or _now_ms - _last_ms > 41400000 then
      _send := true;
    end if;
    _alerting := true;
  elsif _alerting then
    _clean := _clean + 1;
    if _clean >= 2 then
      _recover := _notified;
      _alerting := false; _notified := false; _clean := 0;
    end if;
  end if;

  if _send or _recover then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recover
        then '✅ Challenge 6.0: botga keyin qoʻshilganlarning oldingi xabarlari uchun ballar yana normal hisoblanmoqda.'
        else '⚠️ Challenge 6.0 — botga keyin qoʻshilganlarning oldingi xabarlari uchun ballar: ' || array_to_string(_msgs, ' | ')
             || E'\nTafsilot: admin_actions → challenge_retro_credit_watchdog_report' end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
         where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_purpose := 'challenge-retro-credit-watchdog',
            p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_headers := jsonb_build_object('Content-Type', 'application/json'),
            p_body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3500)),
            p_timeout_ms := 8000);
          _sent := _sent + 1;
        exception when others then null;
        end;
      end loop;
    end if;
    if _send and _sent > 0 then _last_ms := _now_ms; _notified := true; end if;
    if _sent > 0 then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'challenge_retro_credit_watchdog_alert', jsonb_build_object(
          'kind', case when _recover then 'recovered' else 'alert' end, 'alarms', to_jsonb(_alarms),
          'messages', to_jsonb(_msgs), 'sent', _sent, 'at', now()));
      exception when others then null; end;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('challenge_retro_credit_watchdog_state', jsonb_build_object(
    'alerting', _alerting, 'last_alert_ms', _last_ms, 'alarms', to_jsonb(_alarms), 'clean_runs', _clean,
    'notified', _notified, 'last_state', case when cardinality(_alarms) > 0 then 'alarm' else 'ok' end,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  _report := jsonb_build_object(
    'state', case when cardinality(_alarms) > 0 then 'alarm' else 'ok' end,
    'alarms', to_jsonb(_alarms), 'messages', to_jsonb(_msgs), 'dm_sent', _sent, 'recovered', _recover,
    'health', _h, 'at', now());
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_retro_credit_watchdog_report', _report);
  exception when others then null; end;
  return _report;
end
$fn$;

-- ═══════════════════════════════ 10. Grants: service_role only ═══════════════════════════════
revoke execute on function public.challenge_retro_config() from public, anon, authenticated;
grant execute on function public.challenge_retro_config() to service_role;
revoke execute on function public.challenge_retro_attach(uuid, text) from public, anon, authenticated;
grant execute on function public.challenge_retro_attach(uuid, text) to service_role;
revoke execute on function public.challenge_retro_on_profile_link() from public, anon, authenticated;
revoke execute on function public.challenge_retro_credit_run() from public, anon, authenticated;
grant execute on function public.challenge_retro_credit_run() to service_role;
revoke execute on function public.challenge_retro_credit_health() from public, anon, authenticated;
grant execute on function public.challenge_retro_credit_health() to service_role;
revoke execute on function public.challenge_retro_credit_watchdog() from public, anon, authenticated;
grant execute on function public.challenge_retro_credit_watchdog() to service_role;

-- ═══════════════════════════════ 11. Cron (idempotent) ═══════════════════════════════
-- :08 of every 10 minutes: after challenge-xp-reconcile (:00) and challenge-social-reconcile (:03) have usually
-- finished; a collision is a 'locked' run that retries 10 minutes later.
do $$
declare _j record;
begin
  for _j in select jobid from cron.job where jobname in ('challenge-retro-credit', 'challenge-retro-credit-watchdog') loop
    perform cron.unschedule(_j.jobid);
  end loop;
end $$;
select cron.schedule('challenge-retro-credit', '8-59/10 * * * *', $c$ select public.challenge_retro_credit_run() $c$);
select cron.schedule('challenge-retro-credit-watchdog', '57 * * * *', $c$ select public.challenge_retro_credit_watchdog() $c$);

-- ═══════════════════════════════ 12. History heal (once) ═══════════════════════════════
-- Only when the window is ALREADY open at apply time: one pending 'heal' row makes the first sweep run both engines
-- from window.start (idempotent for everything already paid). Before the window opens there is nothing to heal.
do $$
declare _cfg jsonb := public.challenge_retro_config();
begin
  if coalesce((_cfg->>'enabled')::boolean, false) and not coalesce((_cfg->>'win_bad')::boolean, true)
     and now() >= (_cfg->>'w_start')::timestamptz
     and not exists (select 1 from public.challenge_retro_credits where source = 'heal') then
    insert into public.challenge_retro_credits (source, scan_from, status)
    values ('heal', (_cfg->>'w_start')::timestamptz - interval '5 minutes', 'pending');
  end if;
end $$;

-- ═══════════════════════════════ 13. Self-test (NON-mutating) and the audit row ═══════════════════════════════
do $$
declare
  _bad text[] := '{}';
  _cfg jsonb;
  _f text;
  _h jsonb;
begin
  _cfg := public.challenge_retro_config();
  if jsonb_array_length(_cfg->'invalid') <> 0 then _bad := _bad || ('config_invalid:' || (_cfg->'invalid')::text); end if;
  if coalesce((_cfg->>'max_attempts')::int, 0) <= 0 then _bad := _bad || 'config_max_attempts'::text; end if;

  if not (select relrowsecurity from pg_class where oid = 'public.challenge_retro_credits'::regclass) then
    _bad := _bad || 'rls'::text;
  end if;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid in ('public.challenge_retro_credits'::regclass,
                              pg_get_serial_sequence('public.challenge_retro_credits', 'id')::regclass)
                and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))) then
    _bad := _bad || 'table_acl'::text;
  end if;
  foreach _f in array array[
      'public.challenge_retro_config()', 'public.challenge_retro_attach(uuid, text)',
      'public.challenge_retro_on_profile_link()', 'public.challenge_retro_credit_run()',
      'public.challenge_retro_credit_health()', 'public.challenge_retro_credit_watchdog()'] loop
    if not (select prosecdef from pg_proc where oid = _f::regprocedure)
       or (select proacl is null from pg_proc where oid = _f::regprocedure)
       or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = _f::regprocedure
                     and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))) then
      _bad := _bad || ('acl:' || _f);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
                  and t.tgname = 'trg_profiles_challenge_retro_credit' and t.tgenabled = 'O') then
    _bad := _bad || 'trigger'::text;
  end if;
  if to_regclass('public.idx_gme_unlinked_sender') is null then _bad := _bad || 'index'::text; end if;
  if (select count(*) from cron.job where active and jobname in ('challenge-retro-credit', 'challenge-retro-credit-watchdog')) <> 2 then
    _bad := _bad || 'cron'::text;
  end if;

  _h := public.challenge_retro_credit_health();                 -- read-only
  if _h->'queue' is null or _h->'unattached' is null then _bad := _bad || 'health'::text; end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: challenge retro credit self-test failed: %', array_to_string(_bad, ', ');
  end if;

  if not exists (select 1 from public.admin_actions where action = 'challenge_retro_credit_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_retro_credit_applied', jsonb_build_object(
      'window_start', _cfg->'w_start', 'window_end', _cfg->'w_end',
      'unattached_rows', _h#>'{unattached,rows}',
      'heal_enqueued', exists (select 1 from public.challenge_retro_credits where source = 'heal'),
      'scope_group_chats', (select coalesce(jsonb_object_agg(s.id::text, public.group_telegram_chat_id(s.id)), '{}'::jsonb)
                              from public.challenge_scope_group_ids() s(id)),
      'at', now()));
  end if;
end $$;
