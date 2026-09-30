-- Challenge 6.0 daily tasks, PR-6: the AI checker's SQL side (build spec v2 §9). INERT at merge:
-- platform_settings.challenge_tasks stays enabled=false / ai=false (this file never writes that row). While paused
-- or with ai=false the new cron job only stamps a heartbeat row in app_settings; it never calls the checker, an AI
-- provider or Telegram. Go-live is PR-8 (enabled=true, ai=true).
-- RE-ISSUE: this file replaces 20260930151000 (never applied anywhere; removed in the same PR) and adds §5, the PR-6
-- review fixes to PR-3's challenge_task_check_record — the first code that fills check_result.dhash and produces
-- instagram verdicts is this PR's checker, so both defects become reachable only with it.
--
-- ═══ WHAT THIS DOES ═══
-- 1. challenge_task_check_due()  (read-only) — what the kick would do right now: inactive | ai_off | budget | idle | due,
--    with the due count. "Due" uses the SAME filters as PR-3's challenge_task_check_claim (checking, no hold, no live
--    lease, < 5 attempts, the student under ai_max_checks_per_user_day, today's spend under ai_daily_budget_usd), so
--    the kick never wakes the checker for work the claim would not lease.
-- 2. challenge_task_check_kick()  — cron 'challenge-task-check-kick', every minute (spec §9.1; F14: "every minute
--    (tick and check kick)"). Due -> ONE ops_net_post to the new edge function challenge-task-check with
--    {Content-Type, apikey, Authorization: Bearer cron_service_key(), x-internal-secret} and a 60 s timeout. Every run
--    upserts app_settings 'challenge_task_check_kick_state' {checked_at, state, due, kicked, last_kick_at, ...} — the
--    DB-visible heartbeat, also while paused. The budget ceiling and a failing kick each leave one admin_actions row
--    per Tashkent day ('challenge_task_ai_budget_exhausted', 'challenge_task_check_kick_failed').
-- 3. challenge_task_check_media(sub, token)  (read-only) — the raw Telegram Message objects behind a leased
--    submission's items (webhook_inbox for topic posts, the Mini App claim's stored items for Mini App posts), so the
--    checker can call getFile itself: PR-3's ledger keeps file_UNIQUE_ids only, and getFile needs the file_id.
--    Answers only the current lease holder (status 'checking' AND check_token = the caller's token).
-- 4. challenge_task_check_release(sub, token, reason, calls, refund) — gives a lease back without a verdict, and
--    writes the failed calls into the cost ledger (challenge_task_ai_calls). refund=true (a SYSTEMIC failure: every
--    provider down, Telegram unreachable, out of time) also returns the claim's attempt and books those calls with
--    user_id NULL, so an outage never burns a student's 5 check attempts or their ai_max_checks_per_user_day — an
--    instagram submission (which never fails open) would otherwise be stuck for good after ~50 minutes of outage.
--    refund=false (THIS input failed: a refusal, a truncated / schema-breaking answer, a missing screenshot) keeps
--    the attempt spent and writes admin_actions 'challenge_task_check_failed' — after 5, general work fails open via
--    the reconciler and instagram work waits for an admin (the engine watchdog's checks_stuck alarm).
-- 5. A PINNED REWRITE of challenge_task_check_record (PR-3), from its LIVE definition, md5-guarded, two anchored
--    replacements, each asserted to occur exactly once (the review of PR-6 reproduced both defects on PGlite):
--    (a) WHO OWNS A SCREENSHOT. The dHash near-duplicate subquery compared against EVERY instagram row carrying a
--        dHash: rejected, merged, voided, withdrawn and expired rows included, and with no order. A copy rejected
--        first ('ig_handle_mismatch', dHash still stored) then rejected its owner 'image_near_duplicate' (a griefing
--        path: screenshot a classmate's public post and submit it before they do); a later copy that was merely
--        CHECKED first (the claim leases by last_item_at, two rows in flight) did the same; and a move that MERGES left
--        the dHash on the 'merged' source row, so the student's own moved screenshot was rejected in its new task.
--        Now only a row that pays, or can pay again, owns an image: status 'accepted', or 'withdrawn' FROM
--        'accepted' (restore returns it WITHOUT a new check, so dropping those rows would let withdraw -> the same
--        screenshot in another task -> restore pay one screenshot twice). Another student's row counts only when it
--        was submitted before this one (submitted_at, then id); the student's own row in another task always counts
--        (one screenshot pays one task, whatever order the checks ran in).
--    (b) AN UNSURE INSTAGRAM VERDICT NEVER PAYS (C16). not_instagram, ig_handle_mismatch and ig_tag_missing only
--        fire at confidence >= ig.min_confidence (0.6), so a verdict below it skipped all three and was ACCEPTED +8
--        (a deliberately blurry screenshot plus any unused link, with the existence probe OFF). Now, after every
--        other rule, confidence < ig.min_confidence rejects 'ig_unclear' ("send a clearer screenshot"): one of the
--        3 attempts, and the retry is judged fresh (the student's own rejected row never blocks it). General tasks
--        keep failing open by design (C16); their thresholds are unchanged.
--
-- The edge function (supabase/functions/challenge-task-check, same PR, no config.toml entry -> verify_jwt=true with
-- the cron's service-key bearer, then verifyInternalSecret): claim (PR-3) -> media (3) -> getFile + bytes inside the
-- function, base64 to the provider only -> 64-bit dHash (instagram) from a small variant, HEIC / undecodable -> the
-- thumbnail, none -> fingerprint 'unavailable' -> strict-schema verdict (task-v1; general / instagram incl.
-- post_age_text + posted_recently) via _shared/ai-label.ts (Anthropic first, OpenAI fallback, circuit breaker, cost)
-- -> challenge_task_check_record (PR-3: SQL decides, I3) or release (4) -> heartbeat 'challenge_task_check_run'.
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * ops_net_post(text, jsonb, jsonb, text, integer) returns bigint, SECURITY DEFINER, postgres + service_role;
--   cron_service_key() / internal_fn_secret() exist (definer, service_role only); challenge_cfg_int / _num exist.
-- * webhook_inbox keeps raw_update (photo[].file_id / document.file_id / thumbnail present) since 2026-05-06 and is
--   indexed on (chat_id, message_id); update_type is 'message' | 'callback_query' | 'unknown' (edits land as
--   'unknown' — read below by the raw keys, never by update_type).
-- * app_settings has app_settings_audit_trg (BEFORE INSERT/UPDATE): it writes audit_log ONLY when an actor is known
--   (updated_by / auth.uid()), so the cron's per-minute upsert (no actor) adds no audit rows.
-- * Per-minute cron jobs today: broadcast-drainer, new-student-alert-flush, notify-badge-award,
--   notify-homework-submission (plus PR-5's tick, when it lands). The key 'challenge_task_check_kick_state' does NOT
--   match '%_watchdog_state' on purpose: the kick is not a watchdog; a dead kick shows up as the engine watchdog's
--   checks_stuck alarm (queue age > 90 min with ai=true), which is independent of it.
-- * Instagram answers https://www.instagram.com/p/<code>/ with HTTP 200 and the same ~637 KB login-wall page for a
--   real post and an invented shortcode, so the §9.3 existence probe ships OFF (a code constant in the function):
--   every instagram check reports link_status 'unverified' (health ig_link_unverified_7d), never 'not_found'.
-- * gpt-5-mini: image input + structured outputs on /v1/chat/completions ($0.25 / $2 per MTok, as configured);
--   claude-haiku-4-5: vision + output_config json_schema ($1 / $5, as configured).
-- * PR-3 (20260930150020) is applied and ledgered (2026-09-30 17:26 UTC). challenge_task_check_record(bigint, uuid,
--   integer, jsonb, jsonb): md5(replace(prosrc, E'\r', '')) = c0c7e46b9b9aeea4ba3887a7da44c9c0 (= PR-3's file), owner
--   postgres, SECURITY DEFINER, search_path=public, ACL {postgres=X, service_role=X}; each §5 anchor occurs exactly
--   once in its live pg_get_functiondef. challenge_task_submissions has 0 rows (nothing was ever checked: no history
--   to heal). profiles.instagram_username is UNIQUE (uq_profiles_instagram_username), so a copier cannot register the
--   owner's exact handle; the one-character tolerance (handle_edit_distance 1) is the residual — see §5.
--
-- ═══ DEVIATIONS / ADDITIONS (the PR body repeats them) ═══
-- a1 challenge_task_check_media and challenge_task_check_release are NEW (not in the spec's PR-6 list): the first
--    because the engine stores file_unique_ids only; the second so an outage is retried free instead of costing
--    attempts (the spec's "instagram never fails open" would otherwise strand instagram work after any outage).
-- a2 The existence probe is OFF (see VERIFIED): the spec's own fallback ("ship with the probe OFF and only the
--    counter").
-- a3 The kick's heartbeat is an app_settings state row, not an admin_actions row per minute (1,440 rows a day of
--    "nothing due" would bury the signals); every run that actually checks writes 'challenge_task_check_run'.
-- a4 §5 changes PR-3's §9.6 decision function (review fixes). The spec says nothing about WHICH rows own an image
--    or about an instagram verdict below min_confidence; the new reason code 'ig_unclear' needs student copy in
--    PR-4's receipt renderer (until then it shows the generic "vazifa talablariga mos kelmadi").
--
-- ═══ KILL-SWITCHES ═══
-- platform_settings.challenge_tasks.ai = false (or enabled = false): the kick stops calling at once (the next
-- minute). Remove ANTHROPIC_API_KEY and the OpenAI key: the function claims nothing and waits, loudly. Last resort:
-- cron.unschedule('challenge-task-check-kick') (nothing watches the kick state row, so no verifier cleanup needed).
--
-- ═══ DETECTION ═══
-- admin_actions 'challenge_task_check_run' (every checking run: counts, decisions, reasons, cost, providers, images,
-- thumbnail / fingerprint fallbacks, download failures; its reasons map counts 'ig_unclear' and
-- 'image_near_duplicate'), 'challenge_task_check_failed' (a charged failure),
-- 'challenge_task_check_no_provider' / '_no_bot_token' / '_provider_auth_failed' (once a day), 'challenge_task_ai_
-- budget_exhausted', 'challenge_task_check_kick_failed'; challenge_task_ai_calls (every call, incl. failed ones);
-- PR-3's challenge_tasks_health() checks / ai_24h / ig_link_unverified_7d / fingerprint_unavailable_7d and the
-- watchdog's checks_stuck alarm.
--
-- SELF-TEST: non-mutating only — catalog, ACLs, the cron row, and two READ-ONLY calls (check_due() is asserted to
-- say inactive / ai_off only when the live config really is paused; check_media() with a random token answers
-- 'stale'). It never calls the kick, a release, a claim or a record, and never posts. §5 asserts its own result
-- (the stored body's md5, owner, ACL, SECURITY DEFINER) inside its block; it runs nothing.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-ai-check-check.ts (#218 + PR-1 + PR-2 + PR-3 +
-- THIS file; the edge function's run() end to end against the real SQL with fake Telegram / providers; section F
-- reproduces the review's cases against PR-3's body — they FAIL on 20260930151000 — and proves them fixed here).
-- Merge: PR-3 (20260930150020) is ledgered. Label migration-approved, NEVER ops-agent. One at a time.

-- ═══════════════════════════════ 0. Prerequisites: PR-3 (the engine) and the outbound wrapper ═══════════════════════════════
do $$
begin
  if to_regprocedure('public.challenge_task_check_claim(integer)') is null
     or to_regprocedure('public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)') is null
     or to_regprocedure('public.challenge_tasks_config()') is null
     or to_regprocedure('public.challenge_task_note_once(text, uuid, jsonb)') is null
     or to_regprocedure('public.challenge_task_local_date(timestamptz)') is null
     or to_regclass('public.challenge_task_submissions') is null or to_regclass('public.challenge_task_messages') is null
     or to_regclass('public.challenge_task_ai_calls') is null or to_regclass('public.challenge_task_submit_claims') is null then
    raise exception 'ABORT: 20260930150020 (Daily Tasks PR-3: the engine) must be applied first';
  end if;
  if to_regprocedure('public.ops_net_post(text, jsonb, jsonb, text, integer)') is null
     or to_regprocedure('public.cron_service_key()') is null or to_regprocedure('public.internal_fn_secret()') is null
     or to_regprocedure('public.challenge_cfg_int(jsonb)') is null or to_regprocedure('public.challenge_cfg_num(jsonb)') is null then
    raise exception 'ABORT: ops_net_post / cron_service_key / internal_fn_secret / challenge_cfg_int / challenge_cfg_num missing';
  end if;
  -- §5 rewrites challenge_task_check_record: refuse up front (before anything is created) unless it is the verified
  -- live body, or this file's own rewrite of it (a replay)
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
       where oid = 'public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)'::regprocedure)
     not in ('c0c7e46b9b9aeea4ba3887a7da44c9c0', '0f1387a6591d9c3bd9cf008f093a3c94') then
    raise exception 'ABORT: challenge_task_check_record changed since it was verified (md5 %); regenerate this migration from the live definition',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc
        where oid = 'public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)'::regprocedure);
  end if;
end $$;

-- ═══════════════════════════════ 1. What is due (read-only) ═══════════════════════════════
create or replace function public.challenge_task_check_due()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The kick's decision, read-only. The filters are challenge_task_check_claim's (PR-3), so "due" means "the claim
-- would lease something now". state: inactive | ai_off | budget | idle | due.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent');
  _spent numeric;
  _budget numeric := coalesce((_cfg->>'ai_daily_budget_usd')::numeric, 3);
  _cap int := coalesce((_cfg->>'ai_max_checks_per_user_day')::int, 6);
  _due int;
  _queue int;
begin
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('state', 'inactive', 'enabled', _cfg->'enabled', 'challenge_enabled', _cfg->'challenge_enabled');
  end if;
  if not coalesce((_cfg->>'ai')::boolean, false) then
    return jsonb_build_object('state', 'ai_off');
  end if;
  select count(*)::int into _queue from public.challenge_task_submissions s where s.status = 'checking' and s.hold_reason is null;
  select coalesce(sum(c.cost_usd), 0) into _spent from public.challenge_task_ai_calls c where c.created_at >= _day_start;
  if _spent >= _budget then
    return jsonb_build_object('state', 'budget', 'spent_usd', _spent, 'budget_usd', _budget, 'queue', _queue);
  end if;
  select count(*)::int into _due
    from public.challenge_task_submissions s
   where s.status = 'checking' and s.hold_reason is null
     and (s.check_token is null or s.check_claimed_at < now() - interval '10 minutes')
     and s.check_attempts < 5
     and (select count(*) from public.challenge_task_ai_calls c where c.user_id = s.user_id and c.created_at >= _day_start) < _cap;
  return jsonb_build_object('state', case when _due > 0 then 'due' else 'idle' end, 'due', _due, 'queue', _queue,
                            'spent_usd', _spent, 'budget_usd', _budget);
end
$fn$;

-- ═══════════════════════════════ 2. The raw messages behind a leased submission (read-only) ═══════════════════════════════
create or replace function public.challenge_task_check_media(_sub bigint, _token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- For the lease holder ONLY: the Bot API Message object of every counted item, so the checker can getFile.
-- Topic posts: the newest webhook_inbox row for (chat, message) — an edit ('unknown' update type) wins over the
-- original when its raw key carries the same message_id. Mini App posts: the Message the edge function stored in its
-- claim (challenge_task_submit_claims.items). message = null when neither exists (the checker says "not available").
declare
  _s record;
begin
  select s.id, s.user_id, s.status, s.check_token, s.submitted_at into _s
    from public.challenge_task_submissions s where s.id = _sub;
  if not found or _token is null or _s.status <> 'checking' or _s.check_token is distinct from _token then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  return jsonb_build_object(
    'ok', true,
    'submitted_on', public.challenge_task_local_date(_s.submitted_at),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('chat_id', m.chat_id, 'message_id', m.message_id, 'source', m.source,
                                          'message', case when m.source = 'miniapp' then mini.msg else inbox.msg end)
                       order by m.sent_at, m.message_id)
        from public.challenge_task_messages m
        left join lateral (
          select coalesce(case when w.raw_update->'edited_message'->>'message_id' = m.message_id::text then w.raw_update->'edited_message' end,
                          case when w.raw_update->'message'->>'message_id' = m.message_id::text then w.raw_update->'message' end) as msg
            from public.webhook_inbox w
           where w.chat_id = m.chat_id and w.message_id = m.message_id
             and (w.raw_update->'edited_message'->>'message_id' = m.message_id::text
                  or w.raw_update->'message'->>'message_id' = m.message_id::text)
           order by w.received_at desc, w.id desc
           limit 1) inbox on true
        left join lateral (
          select x.value as msg
            from public.challenge_task_submit_claims c
            cross join lateral jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) x
           where m.source = 'miniapp' and c.user_id = m.user_id
             and x.value->>'message_id' = m.message_id::text and x.value->'chat'->>'id' = m.chat_id::text
           order by c.updated_at desc
           limit 1) mini on true
       where m.submission_id = _sub and m.outcome in ('created', 'appended', 'appended_album', 'adopted')), '[]'::jsonb));
end
$fn$;

-- ═══════════════════════════════ 3. Give a lease back without a verdict ═══════════════════════════════
create or replace function public.challenge_task_check_release(_sub bigint, _token uuid, _reason text,
                                                               _calls jsonb default '[]'::jsonb, _refund boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The checker could not produce a verdict. The calls it made go into the cost ledger either way (a failed call can
-- still have cost tokens). refund=true: a SYSTEMIC failure (outage / out of time) — the claim's attempt is returned
-- and the calls are booked with user_id NULL, so they never count toward the student's ai_max_checks_per_user_day.
-- refund=false: THIS input failed — the attempt stays spent and 'challenge_task_check_failed' is written (the engine
-- watchdog alarms on stuck_attempts; general work then fails open via the reconciler, instagram waits for an admin).
-- A stale lease (another run, a new check version, a correction) changes nothing but the ledger.
declare
  _s public.challenge_task_submissions;
  _c jsonb;
  _n int := 0;
  _why text := left(coalesce(nullif(btrim(_reason), ''), 'unspecified'), 200);
begin
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  for _c in select value from jsonb_array_elements(case when jsonb_typeof(_calls) = 'array' then _calls else '[]'::jsonb end) limit 10 loop
    continue when jsonb_typeof(_c) <> 'object';
    insert into public.challenge_task_ai_calls (submission_id, user_id, provider, model, prompt_version, status, input_tokens,
                                                output_tokens, cost_usd, latency_ms, error)
    values (_sub, case when coalesce(_refund, false) then null else _s.user_id end,
            left(_c->>'provider', 40), left(_c->>'model', 80), left(_c->>'prompt_version', 40),
            left(coalesce(_c->>'status', 'error'), 40), public.challenge_cfg_int(_c->'input_tokens'),
            public.challenge_cfg_int(_c->'output_tokens'), greatest(coalesce(public.challenge_cfg_num(_c->'cost_usd'), 0), 0),
            public.challenge_cfg_int(_c->'latency_ms'), left(_c->>'error', 300));
    _n := _n + 1;
  end loop;

  perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  if _token is null or _s.status <> 'checking' or _s.check_token is distinct from _token then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'calls_recorded', _n);
  end if;
  update public.challenge_task_submissions
     set check_token = null, check_claimed_at = null,
         check_attempts = case when coalesce(_refund, false) then greatest(check_attempts - 1, 0) else check_attempts end,
         updated_at = now()
   where id = _sub;
  if not coalesce(_refund, false) then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_check_failed', _s.user_id,
            jsonb_build_object('submission_id', _sub, 'reason', _why, 'attempts', _s.check_attempts, 'at', now()));
  end if;
  return jsonb_build_object('ok', true, 'refunded', coalesce(_refund, false), 'calls_recorded', _n,
                            'attempts', case when coalesce(_refund, false) then greatest(_s.check_attempts - 1, 0) else _s.check_attempts end);
end
$fn$;

-- ═══════════════════════════════ 4. The kick (cron, every minute) ═══════════════════════════════
create or replace function public.challenge_task_check_kick()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §9.1. Calls challenge-task-check ONLY when the claim would lease something (active, ai on, under budget, a due
-- submission). Every run — paused ones included — stamps app_settings 'challenge_task_check_kick_state'; that row is
-- the heartbeat (a disabled run records a DB-visible heartbeat ONLY).
declare
  _d jsonb;
  _kicked boolean := false;
  _err text;
  _prev jsonb;
begin
  begin
    _d := public.challenge_task_check_due();
  exception when others then
    _d := jsonb_build_object('state', 'error');
    _err := left(sqlerrm, 200);
  end;

  if _d->>'state' = 'due' then
    begin
      perform public.ops_net_post(
        p_url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/challenge-task-check',
        p_body := jsonb_build_object('due', _d->'due'),
        p_headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
                                        'Authorization', 'Bearer ' || public.cron_service_key(),
                                        'x-internal-secret', public.internal_fn_secret()),
        p_purpose := 'challenge-task-check',
        p_timeout_ms := 60000);
      _kicked := true;
    exception when others then
      _err := left(sqlerrm, 200);
    end;
  end if;

  -- graceful is not silent: the budget ceiling and a failing kick each leave one row per Tashkent day
  if _d->>'state' = 'budget' then
    perform public.challenge_task_note_once('challenge_task_ai_budget_exhausted', null,
      jsonb_build_object('spent_usd', _d->'spent_usd', 'budget_usd', _d->'budget_usd', 'queue', _d->'queue'));
  end if;
  if _err is not null then
    perform public.challenge_task_note_once('challenge_task_check_kick_failed', null,
      jsonb_build_object('state', _d->>'state', 'error', _err));
  end if;

  select value into _prev from public.app_settings where key = 'challenge_task_check_kick_state';
  insert into public.app_settings (key, value, description)
  values ('challenge_task_check_kick_state',
          jsonb_build_object('checked_at', now(), 'state', _d->>'state', 'due', _d->'due', 'queue', _d->'queue',
                             'spent_usd', _d->'spent_usd', 'kicked', _kicked, 'error', _err,
                             'last_kick_at', case when _kicked then to_jsonb(now()) else coalesce(_prev->'last_kick_at', 'null'::jsonb) end,
                             'kicks_today', case when _kicked then 1 else 0 end
                               + case when (_prev->>'checked_at') is not null
                                        and public.challenge_task_local_date((_prev->>'checked_at')::timestamptz) = public.challenge_task_local_date(now())
                                      then coalesce((_prev->>'kicks_today')::int, 0) else 0 end),
          'Daily Tasks PR-6: heartbeat of cron challenge-task-check-kick (every minute). Written by challenge_task_check_kick().')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return _d || jsonb_build_object('kicked', _kicked, 'error', _err);
end
$fn$;

-- ═══════════════════════════════ 5. Pinned rewrite: challenge_task_check_record (PR-6 review fixes) ═══════════════════════════════
-- From the LIVE pg_get_functiondef, and only when the live prosrc (CRs stripped) is the verified md5. Two anchors, each
-- asserted to occur exactly once. The stored definition must be exactly what was executed, with owner / ACL /
-- SECURITY DEFINER / search_path unchanged and the harness-verified md5. Replay: the rewritten md5 is skipped.
-- (a) who owns a screenshot (the dHash near-duplicate subquery); (b) an unsure instagram verdict -> 'ig_unclear'.
do $$
declare
  _pin constant text := 'c0c7e46b9b9aeea4ba3887a7da44c9c0';       -- live md5(prosrc), read 2026-09-30 (= PR-3's file)
  _new_pin constant text := '0f1387a6591d9c3bd9cf008f093a3c94';  -- the rewritten body (PGlite harness + an independent recompute)
  _old1 constant text := E'                       and (x.user_id <> _s.user_id or x.task_id <> _s.task_id)) o;\n';
  _new1 constant text :=
       E'                       -- 20260930151010 (PR-6 review): only a row that pays, or can pay again, owns an image: accepted,\n'
    || E'                       -- or withdrawn FROM accepted (a restore returns it unchecked). A rejected, merged, voided or expired\n'
    || E'                       -- row never does: a copy rejected first must not block its owner, and a merged row''s screenshot\n'
    || E'                       -- lives on in the row it merged into. Another student''s row counts only when it was submitted\n'
    || E'                       -- BEFORE this one; the student''s own row in another task always counts (one screenshot, one task).\n'
    || E'                       and (x.status = ''accepted'' or (x.status = ''withdrawn'' and x.withdrawn_from = ''accepted''))\n'
    || E'                       and ((x.user_id = _s.user_id and x.task_id <> _s.task_id)\n'
    || E'                            or (x.user_id <> _s.user_id\n'
    || E'                                and (x.submitted_at < _s.submitted_at or (x.submitted_at = _s.submitted_at and x.id < _s.id))))) o;\n';
  _old2 constant text := E'      _decision := ''rejected''; _reason := ''ig_post_old'';\n    end if;\n';
  _new2 constant text :=
       E'      _decision := ''rejected''; _reason := ''ig_post_old'';\n'
    || E'    elsif _conf < coalesce((_cfg->''ig''->>''min_confidence'')::numeric, 0.6) then\n'
    || E'      -- 20260930151010 (PR-6 review): an UNSURE instagram verdict never pays (C16: instagram never fails open). Every\n'
    || E'      -- check above that needs confidence was skipped, so nothing was verified: ask for a clearer screenshot.\n'
    || E'      _decision := ''rejected''; _reason := ''ig_unclear'';\n'
    || E'    end if;\n';
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean; _conf text;
  _n int;
begin
  _fn := to_regprocedure('public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)');
  if _fn is null then
    raise exception 'ABORT: public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb) not found';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef, coalesce(array_to_string(proconfig, ','), '')
    into _src, _acl, _owner, _secdef, _conf from pg_proc where oid = _fn;
  if md5(replace(_src, E'\r', '')) = _new_pin then               -- replay: this file's rewrite is already live
    raise notice 'challenge_task_check_record already carries the PR-6 review fixes -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: challenge_task_check_record changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;
  _def := pg_get_functiondef(_fn);
  _n := (length(_def) - length(replace(_def, _old1, ''))) / length(_old1);
  if _n <> 1 then
    raise exception 'ABORT: challenge_task_check_record anchor (a) matched % times (want exactly 1)', _n;
  end if;
  _n := (length(_def) - length(replace(_def, _old2, ''))) / length(_old2);
  if _n <> 1 then
    raise exception 'ABORT: challenge_task_check_record anchor (b) matched % times (want exactly 1)', _n;
  end if;
  _new := replace(replace(_def, _old1, _new1), _old2, _new2);
  execute _new;
  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: challenge_task_check_record -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef
     or (select coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = _fn) <> _conf then
    raise exception 'ABORT: challenge_task_check_record -- owner, ACL, SECURITY DEFINER or search_path changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: challenge_task_check_record -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 6. Grants: service_role only ═══════════════════════════════
-- anon and authenticated inherit PUBLIC, so every revoke names PUBLIC first.
revoke execute on function public.challenge_task_check_due() from public, anon, authenticated;
grant execute on function public.challenge_task_check_due() to service_role;
revoke execute on function public.challenge_task_check_media(bigint, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_check_media(bigint, uuid) to service_role;
revoke execute on function public.challenge_task_check_release(bigint, uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.challenge_task_check_release(bigint, uuid, text, jsonb, boolean) to service_role;
revoke execute on function public.challenge_task_check_kick() from public, anon, authenticated;
grant execute on function public.challenge_task_check_kick() to service_role;

-- ═══════════════════════════════ 7. Cron (inert while paused: a heartbeat stamp only) ═══════════════════════════════
do $$
declare _j record;
begin
  for _j in select jobid from cron.job where jobname = 'challenge-task-check-kick' loop
    perform cron.unschedule(_j.jobid);
  end loop;
end $$;
select cron.schedule('challenge-task-check-kick', '* * * * *', $c$ select public.challenge_task_check_kick() $c$);

-- ═══════════════════════════════ 8. Self-test (NON-mutating: catalog, ACLs, cron, two read-only calls) ═══════════════════════════════
do $$
declare
  _bad text[] := '{}';
  _r record;
  _cfg jsonb := public.challenge_tasks_config();
  _d jsonb;
  _m jsonb;
begin
  -- four functions, SECURITY DEFINER with a pinned search_path, never PUBLIC / anon / authenticated
  for _r in
    select p.oid::regprocedure::text as sig, p.prosecdef, coalesce(array_to_string(p.proacl, ','), '') as acl,
           coalesce(array_to_string(p.proconfig, ','), '') as conf
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('challenge_task_check_due', 'challenge_task_check_media', 'challenge_task_check_release', 'challenge_task_check_kick')
  loop
    if not _r.prosecdef or _r.conf not like '%search_path=public%' then
      _bad := _bad || ('definer:' || _r.sig);
    end if;
    if _r.acl = '' or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)(anon|authenticated)=' or _r.acl !~ '(^|,)service_role=X' then
      _bad := _bad || ('acl:' || _r.sig || ':' || _r.acl);
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('challenge_task_check_due', 'challenge_task_check_media', 'challenge_task_check_release', 'challenge_task_check_kick')) <> 4 then
    _bad := _bad || 'functions_missing'::text;
  end if;
  -- the cron row, exactly
  if (select count(*) from cron.job
       where jobname = 'challenge-task-check-kick' and schedule = '* * * * *'
         and command = ' select public.challenge_task_check_kick() ') <> 1 then
    _bad := _bad || 'cron'::text;
  end if;
  -- the kick's outbound call carries a Content-Type and goes through ops_net_post (never a raw call)
  if position('''Content-Type'', ''application/json''' in (select prosrc from pg_proc where oid = 'public.challenge_task_check_kick()'::regprocedure)) = 0 then
    _bad := _bad || 'kick_content_type'::text;
  end if;
  -- §5: the decision function is the harness-verified rewrite, still definer + service_role only (catalog read only)
  select p.oid::regprocedure::text as sig, p.prosecdef, coalesce(array_to_string(p.proacl, ','), '') as acl,
         coalesce(array_to_string(p.proconfig, ','), '') as conf, md5(replace(p.prosrc, E'\r', '')) as m
    into _r from pg_proc p where p.oid = 'public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)'::regprocedure;
  if _r.m is distinct from '0f1387a6591d9c3bd9cf008f093a3c94' or not _r.prosecdef or _r.conf not like '%search_path=public%'
     or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)(anon|authenticated)=' or _r.acl !~ '(^|,)service_role=X' then
    _bad := _bad || ('check_record:' || coalesce(_r.m, 'missing') || ':' || coalesce(_r.acl, ''));
  end if;
  -- read-only: the checker's media view refuses a caller that holds no lease
  _m := public.challenge_task_check_media(-1, gen_random_uuid());
  if coalesce((_m->>'ok')::boolean, true) or _m->>'reason' is distinct from 'stale' then
    _bad := _bad || ('media_lease:' || _m::text);
  end if;
  -- read-only, and gated on the CONFIG (never on the answer): while paused the kick must decide "do nothing"
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'ai')::boolean, false) then
    _d := public.challenge_task_check_due();
    if _d->>'state' not in ('inactive', 'ai_off') then
      _bad := _bad || ('due_while_paused:' || _d::text);
    end if;
  else
    raise notice 'challenge_tasks is active with ai=true: the paused-kick self-test is skipped';
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: daily-tasks AI-check self-test failed: %', array_to_string(_bad, ', ');
  end if;
end $$;

-- ═══════════════════════════════ 9. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_task_ai_check_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_ai_check_applied', jsonb_build_object(
      'functions', jsonb_build_array('challenge_task_check_due', 'challenge_task_check_media', 'challenge_task_check_release',
                                     'challenge_task_check_kick'),
      'cron', 'challenge-task-check-kick * * * * *',
      'edge_function', 'challenge-task-check',
      'ig_existence_probe', 'off (login wall answers 200 for every shortcode)',
      'check_record', jsonb_build_object('from', 'c0c7e46b9b9aeea4ba3887a7da44c9c0', 'to', '0f1387a6591d9c3bd9cf008f093a3c94',
                                         'fixes', jsonb_build_array('near_duplicate_owners', 'ig_unclear')),
      'config',(select jsonb_build_object('enabled', c->'enabled', 'ai', c->'ai', 'active', c->'active')
                   from (select public.challenge_tasks_config() as c) x),
      'at', now()));
  end if;
end $$;
