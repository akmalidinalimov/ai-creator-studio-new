-- Challenge 6.0 daily tasks, PR-5: the per-minute TICK, the SQL fallback poster and the missing-task alert (build spec
-- v2 §10). INERT at merge: platform_settings.challenge_tasks stays enabled=false (this file never writes that row). While
-- paused, the new cron job stamps ONE heartbeat row in app_settings and does nothing else -- it queues nothing, posts
-- nothing, sends nothing and never calls the worker. Go-live is PR-8.
--
-- RE-ISSUED as 20260930152010 (replaces 20260930152000, which was never merged or applied): review found that a tick
-- SECTION failing every minute (the morning / evening DMs, the 20:00 summary ...) was recorded but never alarmed, and
-- that 'partial' worker runs were never alarmed. The tick now keeps a per-section failure memory for today in its
-- heartbeat ('failures'), and the watchdog block gains 'tick_errors' and 'worker_partial' (section 6 below).
--
-- ═══ WHAT THIS DOES ═══
-- 1. challenge_tasks_tick() -- cron 'challenge-tasks-tick', every minute (F14). Active only when challenge_tasks.enabled
--    AND challenge.enabled AND a parseable window (challenge_tasks_config().active). Task-day aware (C22 / G6):
--    (0) day rollover: a task / summary post of a PAST date that never went out is 'skipped' (never posted a day late);
--    (a) 09:00 (post_time): one 'task' post row per daily-topic group whose course has an APPROVED task today (a manual
--        post an admin registered wins: the row already exists); a task day with no approved task writes
--        'challenge_task_no_task_today' once per course per day;
--    (b) 09:00-12:00: ONE morning DM per DM-eligible student (C15) of a group with a task today (re-run when a task
--        is approved late, deduped per task + student); a DM that cannot go out by 12:00 expires (payload.expires_at);
--    (c) 20:00 (summary_time): one anonymous 'summary' post row per group whose task post went out today;
--    (d) 19:00-21:00 (remind_time): ONE evening DM ('📅 vazifa seriyasi', G25) per DM-eligible student with at least
--        one OPEN task not yet done -- today's on a task day, a missed one (1-2 days late) any day; nobody who is done
--        is nagged, so a rest day reaches only students with an open missed task (G6); expires at 22:00;
--    (e) from 18:00: the MISSING-TASK ALERT -- when TOMORROW is a task day for a (non-test) course and it has no
--        approved task: 'challenge_task_no_task_tomorrow' + a DM to up to 3 admins, once per course per date;
--    (f) the SQL FALLBACK POSTER: a task post still not sent 15 minutes after post_time (the worker is down / never
--        kicked) goes out through ops_net_post; the next ticks settle it from pg_net's response
--        ('sent_via_sql' + the message id, or 'failed' + challenge_task_post_failed);
--    (g) KICKS the worker (one ops_net_post) only when challenge_tasks_worker_due() says the claims would lease
--        something: posts, receipts, due DMs (outside quiet hours) or identity-sweep senders.
--    Heartbeat: app_settings 'challenge_tasks_tick_state' every run (paused runs included); 'challenge_task_tick' when
--    a run queued or sent anything; 'challenge_task_tick_failed' once a day per failing section. The heartbeat also
--    carries 'failures' -- today's per-section memory {runs, streak (consecutive failing runs), max_streak, first_at,
--    last_at, error} -- which the watchdog reads ('tick_errors'). One tick at a time (pg_try_advisory_xact_lock): a
--    slow run never overlaps the next minute's.
-- 2. challenge_tasks_worker_due(cfg) (read-only) -- the kick's decision, with the claim RPCs' EXACT filters (PR-3), so the
--    tick never wakes the worker for work a claim would not lease.
-- 3. challenge_task_identity_candidates(since, until, exclude, limit) (read-only) -- the worker's identity-sweep input
--    (G1, G9): REGULAR (since null) = the engine's own verdicts of the last 26 h (shaped unknown senders the reconciler
--    recorded in challenge_task_retry, and username-matched students whose profile still has no telegram_id), minus
--    senders a sweep attempted in the last 60 min; WINDOW (since given) = every work-shaped sender in the daily topics
--    in [since, until) who has no profile by telegram_id (PR-8's pre-step: it works while paused). Each candidate
--    carries its latest message's `from`, chat, thread and group, so the worker resolves it exactly like the bot.
-- 4. challenge_task_identity_sweep_request(since, until) -- the admin action behind PR-8's pre-step: ONE call to the
--    worker for a window sweep. It links / registers accounts only; it posts and sends nothing.
-- 5. challenge_tasks_admin_dm(text, purpose) -- up to 3 admins, ops_net_post with Content-Type (the watchdog's recipients).
-- 6. ONE pinned rewrite: challenge_tasks_watchdog (PR-3, live md5 8425d007..., new: _new_pin below) gains a block that
--    watches THIS PR's legs from outside them: 'tick_silent' (the tick state row older than 10 min), 'tick_errors' (a
--    tick section that failed on 3+ consecutive runs, its latest failure in the last hour -- so a section that fails
--    all day, or failed for minutes and stopped between two hourly watchdog runs, both alarm; a one-minute blip does
--    not), 'worker_receipts' (a receipt pending > 30 min, while receipts are on), 'worker_dms' (a due DM pending >
--    60 min, while dm is on, outside the quiet hours + 1 h), 'worker_errors' (a crashed worker run in the last hour)
--    and 'worker_partial' (3+ worker runs in the last hour that finished with errors[], e.g. a record RPC failing
--    every run). Same 24-h dedupe and admin DMs as every other alarm there.
-- 7. idx_ctask_msg_username_match: the per-minute identity check reads username-matched rows by time.
--
-- The edge function supabase/functions/challenge-tasks-worker (same PR; NO config.toml entry -> verify_jwt=true with
-- the tick's service-key bearer, then verifyInternalSecret): posts (post_claim / post_record), receipts
-- (receipt_claim / receipt_record, paced per chat, honouring retry_after), DMs (outbox_claim / outbox_record), the
-- identity sweep (resolveGroupPoster, _shared, PR-0b) -> heartbeat 'challenge_task_worker_run' and
-- 'challenge_task_identity_sweep' {linked, registered, unresolved, attempted}. admin-merge-duplicates now calls
-- challenge_task_reassign_user (PR-3, G24) before it deletes a duplicate.
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * PR-3 (20260930150020) is ledgered (17:26 UTC): post_claim / post_record / receipt_claim / receipt_record /
--   outbox_claim / outbox_record / identity_pending / reassign_user exist, SECURITY DEFINER, postgres + service_role.
--   challenge_tasks_watchdog md5(replace(prosrc, E'\r', '')) = 8425d0076060c3501094d611179baaa0 (the harness asserts
--   the repo's PR-3 body has the same md5); challenge_tasks_health f5ab18b2... (read only, not rewritten).
-- * platform_settings.challenge_tasks: enabled false, ai false, miniapp false, test_group_ids []. platform_settings
--   'telegram' carries bot_token and bot_username (the fallback poster reads both; nothing prints them).
-- * ops_net_post(text, jsonb, jsonb, text, integer) returns the pg_net request id and records it in ops_http_calls;
--   net._http_response is read by ops_http_failure_sweep the same way the fallback reads it here.
-- * cron: 'challenge-tasks-tick' does not exist; the per-minute jobs are broadcast-drainer, new-student-alert-flush,
--   notify-badge-award, notify-homework-submission (+ PR-6's challenge-task-check-kick when it lands). The key
--   'challenge_tasks_tick_state' does NOT match '%_watchdog_state' on purpose: the tick is not a watchdog (the
--   out-of-band verifier watches only those); the rewritten PR-3 watchdog watches the tick instead.
--
-- ═══ DEVIATIONS FROM THE SPEC (each argued; the PR body repeats them) ═══
-- w1 Evening DM on a task day goes only to students with an OPEN task not yet done (today's or a missed one), not to
--    everyone: the spec's rest-day rule ("only students with an open missed task") generalised -- nobody who has
--    finished is nagged (the gamification anti-pattern "notification fatigue"; G25 already moved it off 20:00).
-- w2 The missing-TODAY case writes the row only (the PR-3 watchdog alarms 'no_task_today' at :47 with its DM); the
--    missing-TOMORROW case DMs admins itself at 18:00, because 18:47 is 47 minutes of calendar time lost. The watchdog's
--    own 'no_task_tomorrow' alarm (24-h dedupe) can follow at 18:47 if nobody approved -- a deliberate second nudge.
--    Test-only courses (every group is in test_group_ids) never alarm (E2E noise).
-- w3 identity_pending (PR-3) stays for health / ad-hoc use; the worker reads challenge_task_identity_candidates,
--    which returns the exact (chat, thread) and `from` of each sender's latest message (identity_pending groups by
--    sender and takes max(chat) / max(thread) separately) and applies the 60-minute per-sender backoff the kick needs.
-- w4 The summary post is queued only for a group whose task post went out today (sent / sent_via_sql / manual): an
--    anonymous count under a task nobody saw would only confuse. A missing post already alarms (post_missing).
-- w5 The SQL fallback posts only rows the worker never touched ('queued') or abandoned (a 'sending' lease older than 5
--    minutes) -- never a 'failed' row: Telegram refused those (the worker retries them) and a second sender would not
--    change the answer. One SQL attempt per post (net_request_id stays set), so the two legs never loop.
--
-- ═══ KILL-SWITCHES ═══
-- challenge_tasks.enabled = false (or challenge.enabled = false): the next minute's tick stamps its heartbeat only.
-- post / dm / remind / summary = false stop that leg alone. Last resort: cron.unschedule('challenge-tasks-tick') --
-- the PR-3 watchdog then alarms 'tick_silent' while active (that is the point); unschedule the watchdog too if the
-- whole feature is being retired (and delete app_settings 'challenge_tasks_watchdog_state', PR-3's runbook).
--
-- ═══ DETECTION ═══
-- app_settings 'challenge_tasks_tick_state' (every run; .errors = this run's, .failures = today's per-section memory),
-- admin_actions 'challenge_task_tick' / 'challenge_task_tick_failed'
-- / 'challenge_task_no_task_today' / 'challenge_task_no_task_tomorrow' / 'challenge_task_post_fallback' /
-- 'challenge_task_post_failed' / 'challenge_task_post_skipped'; the worker's 'challenge_task_worker_run' /
-- 'challenge_task_identity_sweep' / 'challenge_task_autoreg_skipped' {chat_admin | not_member | membership_unknown};
-- PR-3's health (receipts / outbox / posts / identity) and the watchdog alarms above.
--
-- SELF-TEST: non-mutating only -- catalog, ACLs, the cron row, the watchdog rewrite's md5, and two READ-ONLY calls
-- (worker_due() is asserted inactive only when the live config really is paused; identity_candidates() answers its
-- shape). It never calls the tick, the sweep request, the admin DM, a claim or a record, and never posts.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-worker-check.ts (#218 + PR-1 + PR-2 + PR-3 + THIS
-- file; the tick on a pinned clock and the worker's runWorker() end to end against the real SQL with a fake Telegram).
-- Merge: after PR-3 (ledgered) and PR-4 / PR-0b (merged: the worker imports their _shared modules). Label
-- migration-approved, NEVER ops-agent. One at a time. Independent of PR-6 (20260930151000).

-- ═══════════════════════════════ 0. Prerequisites: PR-3 (the engine) and the outbound wrapper ═══════════════════════════════
do $$
begin
  if to_regprocedure('public.challenge_task_post_claim(integer)') is null
     or to_regprocedure('public.challenge_task_post_record(bigint, uuid, text, uuid, bigint, text)') is null
     or to_regprocedure('public.challenge_task_receipt_claim(integer)') is null
     or to_regprocedure('public.challenge_task_outbox_claim(integer)') is null
     or to_regprocedure('public.challenge_task_reassign_user(uuid, uuid)') is null
     or to_regprocedure('public.challenge_tasks_watchdog(timestamptz)') is null
     or to_regprocedure('public.challenge_task_is_task_day(uuid, date, jsonb)') is null
     or to_regprocedure('public.challenge_task_dm_eligible(uuid)') is null
     or to_regprocedure('public.challenge_task_streak_current(uuid, uuid)') is null
     or to_regprocedure('public.challenge_task_post_context(public.challenge_tasks)') is null
     or to_regclass('public.challenge_task_outbox') is null or to_regclass('public.challenge_task_retry') is null then
    raise exception 'ABORT: 20260930150020 (Daily Tasks PR-3: the engine) must be applied first';
  end if;
  if to_regprocedure('public.ops_net_post(text, jsonb, jsonb, text, integer)') is null
     or to_regprocedure('public.cron_service_key()') is null or to_regprocedure('public.internal_fn_secret()') is null then
    raise exception 'ABORT: ops_net_post / cron_service_key / internal_fn_secret missing';
  end if;
end $$;

-- ═══════════════════════════════ 1. An index for the per-minute identity check ═══════════════════════════════
create index if not exists idx_ctask_msg_username_match on public.challenge_task_messages (sent_at)
  where resolved_via = 'username_match';

-- ═══════════════════════════════ 2. Admin DMs (the watchdog's recipients) ═══════════════════════════════
create or replace function public.challenge_tasks_admin_dm(_text text, _purpose text)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Up to 3 admins / superadmins with a telegram_id, one ops_net_post each (Content-Type set). Returns how many requests
-- were queued; 0 when there is no bot token (the caller's admin_actions row still records the alert).
declare
  _tok text;
  _admin record;
  _n int := 0;
begin
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' or coalesce(btrim(_text), '') = '' then
    return 0;
  end if;
  for _admin in
    select distinct p.telegram_id from public.profiles p
      join public.user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
     where p.telegram_id is not null
     limit 3
  loop
    begin
      perform public.ops_net_post(
        p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        p_body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_text, 3500)),
        p_headers := jsonb_build_object('Content-Type', 'application/json'),
        p_purpose := coalesce(_purpose, 'challenge-tasks-admin-dm'),
        p_timeout_ms := 8000);
      _n := _n + 1;
    exception when others then
      null;
    end;
  end loop;
  return _n;
end
$fn$;

-- ═══════════════════════════════ 3. The identity-sweep input (read-only) ═══════════════════════════════
create or replace function public.challenge_task_identity_candidates(_since timestamptz default null, _until timestamptz default null,
                                                                     _exclude bigint[] default '{}', _limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The senders the worker's identity sweep should resolve (G1, G9). Each candidate:
--   {kind: unknown | username_match, tg_user_id, user_id (username_match), chat_id, thread_id, message_id, group_id,
--    course_id, from (the Telegram `from` of that message, or a minimal {id, username})}
-- REGULAR (_since null): the engine's verdicts of the last 26 hours -- shaped unknown senders in challenge_task_retry
-- (written by the reconciler) and username-matched ledger rows whose profile still has no telegram_id -- minus anyone a
-- sweep attempted in the last 60 minutes (the kick's backoff: an unresolvable sender is retried ~26 times, not 1,560).
-- WINDOW (_since given, _until default now()): every sender of a work-shaped message (capture's `shaped` rule) in the
-- daily topics in [_since, _until) with no profile by telegram_id. It reads webhook_inbox directly, so it also works
-- while the feature is paused (PR-8's pre-step: nothing is captured before go-live). _exclude: the senders this run
-- already tried (the worker pages with it).
declare
  _cfg jsonb := public.challenge_tasks_config();
  _min int := coalesce((_cfg->>'min_text_chars')::int, 20);
  _lim int := greatest(1, least(coalesce(_limit, 20), 100));
  _ex bigint[] := coalesce(_exclude, '{}');
  _out jsonb;
begin
  if _since is null then
    with recent as (
      select distinct (x #>> '{}')::bigint as tg
        from public.admin_actions a
        cross join lateral jsonb_array_elements(case when jsonb_typeof(a.details->'attempted') = 'array'
                                                     then a.details->'attempted' else '[]'::jsonb end) x
       where a.action = 'challenge_task_identity_sweep' and a.created_at >= now() - interval '60 minutes'
         and jsonb_typeof(x) = 'number'
    ), unk as (
      select distinct on (r.tg_user_id) 'unknown'::text as kind, r.tg_user_id, null::uuid as user_id, r.chat_id, r.thread_id,
             r.message_id, r.group_id, r.tg_username, r.last_at as at
        from public.challenge_task_retry r
       where r.outcome = 'unknown_sender' and r.shaped and r.tg_user_id is not null
         and coalesce(r.message_at, r.first_at) >= now() - interval '26 hours'
         and not exists (select 1 from public.profiles p where p.telegram_id = r.tg_user_id)
       order by r.tg_user_id, r.last_at desc
    ), um as (
      -- tg_username: the username that matched (the profile's), in case the raw message is gone from webhook_inbox
      select distinct on (m.tg_user_id) 'username_match'::text as kind, m.tg_user_id, m.user_id, m.chat_id, m.thread_id,
             m.message_id, m.group_id, p.telegram_username::text as tg_username, m.sent_at as at
        from public.challenge_task_messages m
        join public.profiles p on p.id = m.user_id
       where m.resolved_via = 'username_match' and p.telegram_id is null and m.tg_user_id is not null
         and m.sent_at >= now() - interval '26 hours'
         and not exists (select 1 from public.profiles q where q.telegram_id = m.tg_user_id)
       order by m.tg_user_id, m.sent_at desc
    ), c as (
      select * from unk
      union all
      select * from um where um.tg_user_id not in (select unk.tg_user_id from unk)
    ), pick as (
      select c.* from c
       where not (c.tg_user_id = any(_ex)) and c.tg_user_id not in (select recent.tg from recent)
       order by c.at desc
       limit _lim
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'kind', pick.kind, 'tg_user_id', pick.tg_user_id, 'user_id', pick.user_id, 'chat_id', pick.chat_id,
             'thread_id', pick.thread_id, 'message_id', pick.message_id, 'group_id', pick.group_id, 'course_id', t.course_id,
             'from', coalesce(w.m->'from', jsonb_build_object('id', pick.tg_user_id, 'username', pick.tg_username)))
             order by pick.at desc), '[]'::jsonb)
      into _out
      from pick
      left join public.challenge_task_topics() t on t.chat_id = pick.chat_id and t.thread_id = pick.thread_id
      left join lateral (
        select wi.raw_update->'message' as m from public.webhook_inbox wi
         where wi.chat_id = pick.chat_id and wi.message_id = pick.message_id and wi.update_type = 'message'
         order by wi.received_at desc limit 1) w on true;
    return jsonb_build_object('mode', 'regular', 'candidates', _out);
  end if;

  with msgs as (
    select w.id, w.received_at, w.chat_id, w.message_id, w.message_thread_id as thread_id, w.from_user_id,
           w.raw_update->'message' as m, t.group_id, t.course_id,
           public.challenge_task_classify(w.raw_update->'message') as it
      from public.webhook_inbox w
      join public.challenge_task_topics() t on t.chat_id = w.chat_id and t.thread_id = w.message_thread_id
     where w.update_type = 'message' and w.received_at >= _since and w.received_at < coalesce(_until, now())
       and w.from_user_id is not null and w.from_user_id <> 1087968824
       and jsonb_typeof(w.raw_update->'message') = 'object'
       and not (w.raw_update->'message' ? 'sender_chat')
       and not coalesce((w.raw_update->'message'->'from'->>'is_bot')::boolean, false)
       and not (w.from_user_id = any(_ex))
       and not exists (select 1 from public.profiles p where p.telegram_id = w.from_user_id)
  ), shaped as (
    -- capture's `shaped` rule (20260930150020 §4): not a forward of someone else, not a question, and media / an IG
    -- link / at least min_text_chars of text
    select * from msgs
     where not coalesce((it->>'forward_other')::boolean, false) and not coalesce((it->>'question')::boolean, false)
       and (coalesce((it->>'media')::boolean, false) or coalesce((it->>'ig_link')::boolean, false)
            or coalesce((it->>'text_len')::int, 0) >= _min)
  ), latest as (
    select distinct on (s.from_user_id) s.* from shaped s order by s.from_user_id, s.received_at desc, s.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'unknown', 'tg_user_id', l.from_user_id, 'user_id', null, 'chat_id', l.chat_id, 'thread_id', l.thread_id,
           'message_id', l.message_id, 'group_id', l.group_id, 'course_id', l.course_id,
           'from', coalesce(l.m->'from', jsonb_build_object('id', l.from_user_id)))
           order by l.received_at), '[]'::jsonb)
    into _out
    from (select * from latest order by latest.received_at limit _lim) l;
  return jsonb_build_object('mode', 'window', 'since', _since, 'until', coalesce(_until, now()), 'candidates', _out);
end
$fn$;

-- ═══════════════════════════════ 4. What the worker would lease right now (read-only) ═══════════════════════════════
create or replace function public.challenge_tasks_worker_due(_cfg jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The kick's decision. Each count uses the SAME filter as the PR-3 claim that would lease it (post_claim,
-- receipt_claim, outbox_claim incl. its quiet hours) or the sweep input above, so a kick always finds work.
declare
  _c jsonb := coalesce(_cfg, public.challenge_tasks_config());
  _now time := (now() at time zone 'Asia/Tashkent')::time;
  _qs time := coalesce((_c->>'quiet_start')::time, time '22:00');
  _qe time := coalesce((_c->>'quiet_end')::time, time '08:00');
  _posts int := 0;
  _receipts int := 0;
  _dms int := 0;
  _identity int := 0;
begin
  if not coalesce((_c->>'active')::boolean, false) then
    return jsonb_build_object('state', 'inactive', 'posts', 0, 'receipts', 0, 'dms', 0, 'identity', 0, 'total', 0);
  end if;
  if coalesce((_c->>'post')::boolean, true) then
    select count(*)::int into _posts
      from public.challenge_task_posts p
      join public.challenge_tasks t on t.id = p.task_id
     where (p.state = 'queued' or (p.state = 'failed' and p.attempts < 5)
            or (p.state = 'sending' and p.claimed_at < now() - interval '5 minutes'))
       and t.status = 'approved';
  end if;
  if coalesce((_c->>'receipts')::boolean, true) then
    select count(*)::int into _receipts
      from public.challenge_task_submissions s
     where s.receipt_version > s.receipt_sent_version
       and (s.receipt_state = 'pending' or (s.receipt_state = 'sending' and s.receipt_claimed_at < now() - interval '5 minutes'));
  end if;
  if coalesce((_c->>'dm')::boolean, true)
     and not ((_qs > _qe and (_now >= _qs or _now < _qe)) or (_qs < _qe and _now >= _qs and _now < _qe)) then
    select count(*)::int into _dms
      from public.challenge_task_outbox o
      join public.profiles p on p.id = o.user_id
     where (o.state = 'pending' or (o.state = 'sending' and o.claimed_at < now() - interval '5 minutes'))
       and o.not_before <= now() and o.attempts < 5;
  end if;
  _identity := jsonb_array_length(coalesce(public.challenge_task_identity_candidates(null, null, '{}', 1)->'candidates', '[]'::jsonb));
  return jsonb_build_object('state', 'active', 'posts', _posts, 'receipts', _receipts, 'dms', _dms, 'identity', _identity,
                            'total', _posts + _receipts + _dms + _identity);
end
$fn$;

-- ═══════════════════════════════ 5. The tick (cron, every minute) ═══════════════════════════════
create or replace function public.challenge_tasks_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §10.1. See the file header for (0) .. (g). Every section runs in its own sub-block: a failure rolls back that section
-- only, and is recorded once a day per section ('challenge_task_tick_failed'). While paused: the heartbeat ONLY.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _prev jsonb;
  _done jsonb;
  _today date := public.challenge_task_local_date(now());
  _day_start timestamptz := (public.challenge_task_local_date(now())::timestamp at time zone 'Asia/Tashkent');
  _lt time := (now() at time zone 'Asia/Tashkent')::time;
  _post time := coalesce((_cfg->>'post_time')::time, time '09:00');
  _remind time := coalesce((_cfg->>'remind_time')::time, time '19:00');
  _summary time := coalesce((_cfg->>'summary_time')::time, time '20:00');
  _qs time := coalesce((_cfg->>'quiet_start')::time, time '22:00');
  _qe time := coalesce((_cfg->>'quiet_end')::time, time '08:00');
  _late int := coalesce((_cfg->>'late_days')::int, 2);
  _max_att int := coalesce((_cfg->>'max_attempts_per_task')::int, 3);
  _quiet boolean;
  _out jsonb := '{}'::jsonb;
  _err jsonb := '{}'::jsonb;
  _n int;
  _j jsonb;
  _r record;
  _resp record;
  _mid bigint;
  _e text;
  _tok text;
  _bot text;
  _ftok uuid;
  _rid bigint;
  _dm int;
  _txt text;
  _due jsonb;
  _kicked boolean := false;
  _k text;
  _v jsonb;
  _fail jsonb;
begin
  -- one tick at a time (a slow run must never overlap the next minute's): a miss changes nothing and is harmless,
  -- the next minute retries; the heartbeat row shows the last run that got the lock
  if not pg_try_advisory_xact_lock(hashtext('challenge_tasks_tick')) then
    return jsonb_build_object('state', 'busy');
  end if;
  select value into _prev from public.app_settings where key = 'challenge_tasks_tick_state';
  _prev := coalesce(_prev, '{}'::jsonb);

  if not coalesce((_cfg->>'active')::boolean, false) then
    -- PAUSED: a DB-visible heartbeat and nothing else (nothing queued, posted, sent or kicked)
    insert into public.app_settings (key, value, description)
    values ('challenge_tasks_tick_state',
            jsonb_build_object('checked_at', now(), 'state', 'inactive', 'enabled', _cfg->'enabled',
                               'challenge_enabled', _cfg->'challenge_enabled', 'last_active_at', _prev->'last_active_at',
                               'last_kick_at', _prev->'last_kick_at'),
            'Daily Tasks PR-5: heartbeat of cron challenge-tasks-tick (every minute). Written by challenge_tasks_tick().')
    on conflict (key) do update set value = excluded.value, updated_at = now();
    return jsonb_build_object('state', 'inactive');
  end if;

  perform public.challenge_tasks_note_invalid(_cfg);
  _quiet := (_qs > _qe and (_lt >= _qs or _lt < _qe)) or (_qs < _qe and _lt >= _qs and _lt < _qe);
  _done := case when jsonb_typeof(_prev->'done') = 'object' and _prev->'done'->>'date' = _today::text
                then _prev->'done' else jsonb_build_object('date', _today) end;

  -- (0) day rollover: a post of a PAST task date that never went out is skipped, never posted a day late
  begin
    with s as (
      update public.challenge_task_posts p
         set state = 'skipped', claim_token = null,
             error = left('stale: the task date passed before it was posted' || coalesce(' (' || p.error || ')', ''), 300)
        from public.challenge_tasks t
       where t.id = p.task_id and t.task_date < _today
         and (p.state in ('queued', 'failed') or (p.state = 'sending' and p.claimed_at < now() - interval '10 minutes'))
      returning p.task_id, p.group_id, p.kind, t.task_date)
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('task_id', s.task_id, 'group_id', s.group_id, 'kind', s.kind,
                                                                 'task_date', s.task_date)), '[]'::jsonb)
      into _n, _j from s;
    if _n > 0 then
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_task_post_skipped', jsonb_build_object('posts', _j, 'at', now()));
      _out := _out || jsonb_build_object('posts_skipped', _n);
    end if;
  exception when others then
    _err := _err || jsonb_build_object('rollover', left(sqlerrm, 200));
  end;

  -- (a) the task post at post_time (an approved task today = a task day); a task day with no approved task: a row
  if _lt >= _post then
    begin
      if coalesce((_cfg->>'post')::boolean, true) then
        insert into public.challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id)
        select t.id, g.group_id, 'task', 'queued', g.chat_id, g.thread_id
          from public.challenge_task_topics() g
          join public.challenge_tasks t on t.course_id = g.course_id and t.task_date = _today and t.status = 'approved'
        on conflict (task_id, group_id, kind) do nothing;
        get diagnostics _n = row_count;
        if _n > 0 then _out := _out || jsonb_build_object('posts_queued', _n); end if;
      end if;
      for _r in
        select g.course_id from public.challenge_task_topics() g group by g.course_id having bool_or(not g.is_test)
      loop
        if public.challenge_task_is_task_day(_r.course_id, _today, _cfg)
           and not exists (select 1 from public.challenge_tasks t
                            where t.course_id = _r.course_id and t.task_date = _today and t.status = 'approved')
           and not exists (select 1 from public.admin_actions a
                            where a.action = 'challenge_task_no_task_today' and a.created_at >= _day_start
                              and a.details->>'course_id' = _r.course_id::text) then
          insert into public.admin_actions (actor_user_id, action, details)
          values (null, 'challenge_task_no_task_today', jsonb_build_object('course_id', _r.course_id, 'date', _today, 'at', now()));
          _out := _out || jsonb_build_object('no_task_today', true);
        end if;
      end loop;
    exception when others then
      _err := _err || jsonb_build_object('post', left(sqlerrm, 200));
    end;
  end if;

  -- (b) morning DMs: post_time .. +3 h, DM-eligible students of a group with a task today (C15). Runs once per SET of
  --     today's approved tasks (a task approved at 09:40 still gets its morning DMs; the dedupe key stops doubles).
  _j := (select coalesce(jsonb_agg(t.id order by t.id), '[]'::jsonb) from public.challenge_tasks t
          where t.task_date = _today and t.status = 'approved'
            and t.course_id in (select g.course_id from public.challenge_task_topics() g));
  if coalesce((_cfg->>'dm')::boolean, true) and _done->'morning' is distinct from _j and jsonb_array_length(_j) > 0
     and _lt >= _post and _lt < _post + interval '3 hours' and not _quiet then
    begin
      insert into public.challenge_task_outbox (user_id, kind, task_id, dedupe_key, payload)
      select p.id, 'morning', tt.id, 'morning:' || tt.id::text || ':' || p.id::text,
             jsonb_build_object('task_id', tt.id, 'task_date', tt.task_date, 'day_no', tt.day_no, 'type', tt.type,
                                'title', tt.title, 'points', tt.points, 'late_points', tt.late_points,
                                'group_id', g.group_id, 'topic_url', gr.daily_task_topic_url,
                                -- a "good morning" that could not go out by then is dropped, never sent at night
                                'expires_at', ((_today + _post)::timestamp at time zone 'Asia/Tashkent') + interval '3 hours')
        from public.challenge_task_topics() g
        join public.groups gr on gr.id = g.group_id
        join lateral (
          select t.id, t.task_date, t.type, t.title, c.day_no, c.points, c.late_points
            from public.challenge_tasks t
            cross join lateral public.challenge_task_post_context(t) c
           where t.course_id = g.course_id and t.task_date = _today and t.status = 'approved') tt on true
        join public.profiles p on p.group_id = g.group_id
       where p.status::text = 'active' and p.archived_at is null and p.telegram_id is not null
         and not exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = p.id)
         and public.challenge_task_dm_eligible(p.id)
      on conflict (dedupe_key) do nothing;
      get diagnostics _n = row_count;
      _out := _out || jsonb_build_object('morning_queued', _n);
      _done := _done || jsonb_build_object('morning', _j);
    exception when others then
      _err := _err || jsonb_build_object('morning', left(sqlerrm, 200));
    end;
  end if;

  -- (c) the anonymous topic summary at summary_time, under a task post that went out today (w4)
  if coalesce((_cfg->>'summary')::boolean, true) and coalesce((_cfg->>'post')::boolean, true) and _lt >= _summary then
    begin
      insert into public.challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id)
      select t.id, g.group_id, 'summary', 'queued', g.chat_id, g.thread_id
        from public.challenge_task_topics() g
        join public.challenge_tasks t on t.course_id = g.course_id and t.task_date = _today and t.status = 'approved'
       where exists (select 1 from public.challenge_task_posts x
                      where x.task_id = t.id and x.group_id = g.group_id and x.kind = 'task'
                        and x.state in ('sent', 'sent_via_sql', 'manual'))
      on conflict (task_id, group_id, kind) do nothing;
      get diagnostics _n = row_count;
      if _n > 0 then _out := _out || jsonb_build_object('summaries_queued', _n); end if;
    exception when others then
      _err := _err || jsonb_build_object('summary', left(sqlerrm, 200));
    end;
  end if;

  -- (d) evening DMs ('📅 vazifa seriyasi', G25): once a day, remind_time .. +2 h, to DM-eligible students with at least
  --     one OPEN task not yet done (w1): today's on a task day, a missed one (1..late_days late) on any day
  if coalesce((_cfg->>'dm')::boolean, true) and coalesce((_cfg->>'remind')::boolean, true)
     and not coalesce((_done->>'evening')::boolean, false)
     and _lt >= _remind and _lt < _remind + interval '2 hours' and not _quiet then
    begin
      with st as (
        select p.id as user_id, g.group_id, g.course_id, gr.daily_task_topic_url as topic_url
          from public.challenge_task_topics() g
          join public.groups gr on gr.id = g.group_id
          join public.profiles p on p.group_id = g.group_id
         where p.status::text = 'active' and p.archived_at is null and p.telegram_id is not null
           and not exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = p.id)
           and public.challenge_task_dm_eligible(p.id)
      ), pend as (
        select st.user_id, st.group_id, st.course_id, st.topic_url, t.id as task_id, t.task_date, t.title, t.type,
               public.challenge_task_points_for(t, _today - t.task_date, _cfg) as points
          from st
          join public.challenge_tasks t on t.course_id = st.course_id and t.status = 'approved'
                                       and t.task_date between _today - _late and _today
         where public.challenge_task_open_at(t, st.group_id, _cfg) <= now()
           and now() < public.challenge_task_close_at(t, _cfg)
           and not exists (select 1 from public.challenge_task_submissions s
                            where s.user_id = st.user_id and s.task_id = t.id and s.status in ('accepted', 'checking'))
           and public.challenge_task_rejected_count(st.user_id, t.id) < _max_att
      )
      insert into public.challenge_task_outbox (user_id, kind, task_id, dedupe_key, payload)
      select x.user_id, 'evening', max(x.task_id) filter (where x.task_date = _today),
             'evening:' || _today::text || ':' || x.user_id::text,
             jsonb_build_object('date', _today, 'group_id', x.group_id, 'topic_url', x.topic_url,
                                'expires_at', ((_today + _remind)::timestamp at time zone 'Asia/Tashkent') + interval '3 hours',
                                'streak_days', public.challenge_task_streak_current(x.user_id, x.course_id),
                                'pending', jsonb_agg(jsonb_build_object('task_id', x.task_id, 'date', x.task_date, 'title', x.title,
                                                                        'type', x.type, 'late_days', _today - x.task_date,
                                                                        'points', x.points) order by x.task_date desc))
        from pend x
       group by x.user_id, x.group_id, x.course_id, x.topic_url
      on conflict (dedupe_key) do nothing;
      get diagnostics _n = row_count;
      _out := _out || jsonb_build_object('evening_queued', _n);
      _done := _done || jsonb_build_object('evening', true);
    exception when others then
      _err := _err || jsonb_build_object('evening', left(sqlerrm, 200));
    end;
  end if;

  -- (e) THE MISSING-TASK ALERT: from 18:00, tomorrow is a task day for a (non-test) course and has no approved task
  --     -> 'challenge_task_no_task_tomorrow' + admin DMs, once per course per date (w2)
  if _lt >= time '18:00' then
    begin
      for _r in
        select g.course_id from public.challenge_task_topics() g group by g.course_id having bool_or(not g.is_test)
      loop
        continue when not public.challenge_task_is_task_day(_r.course_id, _today + 1, _cfg);
        continue when exists (select 1 from public.challenge_tasks t
                               where t.course_id = _r.course_id and t.task_date = _today + 1 and t.status = 'approved');
        continue when exists (select 1 from public.admin_actions a
                               where a.action = 'challenge_task_no_task_tomorrow' and a.created_at >= _day_start
                                 and a.details->>'course_id' = _r.course_id::text);
        _n := (select count(*)::int from public.challenge_tasks t
                where t.course_id = _r.course_id and t.task_date = _today + 1 and t.status = 'draft');
        _txt := '📅 Kunlik vazifalar: ertangi (' || extract(day from _today + 1)::int::text || '-'
             || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from _today + 1)::int]
             || ', ' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from _today + 1)::int]
             || ') vazifa hali TASDIQLANMAGAN'
             || coalesce(' — «' || (select c.title from public.courses c where c.id = _r.course_id) || '»', '')
             || case when _n > 0 then '. Qoralama bor: Admin → Kunlik vazifalar → «Tasdiqlash».'
                     else '. Kalendarda vazifa yo‘q: Admin → Kunlik vazifalar.' end
             || E'\nTasdiqlanmasa, ertaga ' || to_char(_post, 'HH24:MI') || ' da guruhlarga vazifa chiqmaydi.';
        _dm := public.challenge_tasks_admin_dm(_txt, 'challenge-tasks-tomorrow-check');
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'challenge_task_no_task_tomorrow', jsonb_build_object('course_id', _r.course_id, 'date', _today + 1,
                'drafts', _n, 'dm_sent', _dm, 'at', now()));
        _out := _out || jsonb_build_object('no_task_tomorrow', true);
      end loop;
    exception when others then
      _err := _err || jsonb_build_object('tomorrow', left(sqlerrm, 200));
    end;
  end if;

  -- (f) THE SQL FALLBACK POSTER (w5). f1: settle the fallback's in-flight requests from pg_net's response table.
  if coalesce((_cfg->>'post')::boolean, true) then
    begin
      if to_regclass('net._http_response') is not null then
        for _r in
          select p.task_id, p.group_id, p.kind, p.net_request_id, p.claimed_at
            from public.challenge_task_posts p
           where p.state = 'sending' and p.net_request_id is not null and p.claim_token is not null
             and p.error = 'sql_fallback:' || p.claim_token::text
           for update of p skip locked
        loop
          select r.status_code, r.content, r.error_msg, r.created into _resp from net._http_response r where r.id = _r.net_request_id;
          if found then
            _mid := null;
            _j := null;
            begin
              _j := _resp.content::jsonb;
              _mid := (_j->'result'->>'message_id')::bigint;
            exception when others then
              _mid := null;
            end;
            if _resp.status_code = 200 and _mid is not null then
              update public.challenge_task_posts
                 set state = 'sent_via_sql', message_id = _mid, sent_at = coalesce(_resp.created, now()), error = null, claim_token = null
               where task_id = _r.task_id and group_id = _r.group_id and kind = _r.kind;
              insert into public.admin_actions (actor_user_id, action, details)
              values (null, 'challenge_task_post_fallback', jsonb_build_object('task_id', _r.task_id, 'group_id', _r.group_id,
                      'kind', _r.kind, 'result', 'sent_via_sql', 'message_id', _mid, 'request_id', _r.net_request_id, 'at', now()));
              _out := _out || jsonb_build_object('fallback_sent', coalesce((_out->>'fallback_sent')::int, 0) + 1);
            else
              _e := left('sql_fallback_failed: ' || coalesce('http_' || _resp.status_code::text, 'no_status') || ' '
                         || coalesce(_j->>'description', _resp.error_msg, ''), 300);
              update public.challenge_task_posts set state = 'failed', error = _e, claim_token = null
               where task_id = _r.task_id and group_id = _r.group_id and kind = _r.kind;
              insert into public.admin_actions (actor_user_id, action, details)
              values (null, 'challenge_task_post_failed', jsonb_build_object('task_id', _r.task_id, 'group_id', _r.group_id,
                      'kind', _r.kind, 'error', _e, 'via', 'sql_fallback', 'request_id', _r.net_request_id, 'at', now()));
            end if;
          elsif _r.claimed_at < now() - interval '5 minutes' then
            -- pg_net never answered: the request most likely never left (the worker may retry: attempts < 5)
            update public.challenge_task_posts set state = 'failed', error = 'sql_fallback_failed: no pg_net response in 5 minutes',
                   claim_token = null
             where task_id = _r.task_id and group_id = _r.group_id and kind = _r.kind;
            insert into public.admin_actions (actor_user_id, action, details)
            values (null, 'challenge_task_post_failed', jsonb_build_object('task_id', _r.task_id, 'group_id', _r.group_id,
                    'kind', _r.kind, 'error', 'no pg_net response in 5 minutes', 'via', 'sql_fallback', 'request_id', _r.net_request_id, 'at', now()));
          end if;
        end loop;
      end if;

      -- f2: a task post of TODAY that the worker never sent 15 minutes after post_time goes out through ops_net_post:
      --     only rows nobody holds ('queued', or a 'sending' lease older than 5 minutes), once (net_request_id is null)
      if _lt >= _post + interval '15 minutes' then
        select value->>'bot_token', value->>'bot_username' into _tok, _bot from public.platform_settings where key = 'telegram';
        if coalesce(_tok, '') <> '' then
          for _r in
            select p.task_id, p.group_id, p.kind, p.chat_id, p.thread_id, public.challenge_task_render_post(t) as body
              from public.challenge_task_posts p
              join public.challenge_tasks t on t.id = p.task_id
             where p.kind = 'task' and t.status = 'approved' and t.task_date = _today and p.net_request_id is null
               and (p.state = 'queued' or (p.state = 'sending' and p.claimed_at < now() - interval '5 minutes'))
               and p.created_at < now() - interval '10 minutes'
             for update of p skip locked
          loop
            _ftok := gen_random_uuid();
            _rid := public.ops_net_post(
              p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              p_body := jsonb_strip_nulls(jsonb_build_object(
                'chat_id', _r.chat_id, 'message_thread_id', _r.thread_id, 'text', _r.body, 'parse_mode', 'HTML',
                'disable_web_page_preview', true,
                -- the worker's post button (challenge-tasks-worker/render.ts POST_BUTTON_TEXT; the harness asserts equality)
                'reply_markup', case when coalesce(_bot, '') ~ '^[A-Za-z0-9_]{3,64}$' then
                  jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(jsonb_build_object(
                    'text', '📲 Vazifani botda ochish', 'url', 'https://t.me/' || _bot || '?start=dt_' || _r.task_id::text)))) end)),
              p_headers := jsonb_build_object('Content-Type', 'application/json'),
              p_purpose := 'challenge-tasks-fallback-post',
              p_timeout_ms := 15000);
            update public.challenge_task_posts
               set state = 'sending', claim_token = _ftok, claimed_at = now(), attempts = attempts + 1, net_request_id = _rid,
                   error = 'sql_fallback:' || _ftok::text
             where task_id = _r.task_id and group_id = _r.group_id and kind = _r.kind;
            insert into public.admin_actions (actor_user_id, action, details)
            values (null, 'challenge_task_post_fallback', jsonb_build_object('task_id', _r.task_id, 'group_id', _r.group_id,
                    'kind', _r.kind, 'result', 'requested', 'request_id', _rid, 'at', now()));
            _out := _out || jsonb_build_object('fallback_requested', coalesce((_out->>'fallback_requested')::int, 0) + 1);
          end loop;
        end if;
      end if;
    exception when others then
      _err := _err || jsonb_build_object('fallback', left(sqlerrm, 200));
    end;
  end if;

  -- (g) kick the worker only when a claim would lease something
  begin
    _due := public.challenge_tasks_worker_due(_cfg);
    if coalesce((_due->>'total')::int, 0) > 0 then
      perform public.ops_net_post(
        p_url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/challenge-tasks-worker',
        p_body := jsonb_build_object('mode', 'run', 'due', _due),
        p_headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
                                        'Authorization', 'Bearer ' || public.cron_service_key(),
                                        'x-internal-secret', public.internal_fn_secret()),
        p_purpose := 'challenge-tasks-worker',
        p_timeout_ms := 60000);
      _kicked := true;
    end if;
  exception when others then
    _err := _err || jsonb_build_object('kick', left(sqlerrm, 200));
  end;

  -- today's per-section failure memory (the PR-3 watchdog's 'tick_errors' reads it): runs = failing runs today,
  -- streak = consecutive failing runs (any run in which the section did not fail resets it to 0), max_streak, first_at,
  -- last_at, error. A section that fails every minute, or failed for minutes and recovered between two hourly watchdog
  -- runs, stays visible there; a one-minute blip (max_streak 1) is not an alarm. Reset at the Tashkent day change.
  _fail := case when jsonb_typeof(_prev->'failures') = 'object' and _prev->'failures'->>'date' = _today::text
                then _prev->'failures' else jsonb_build_object('date', _today) end;
  for _k in select f.key from jsonb_each(_fail) f where jsonb_typeof(f.value) = 'object' and not (_err ? f.key) loop
    _fail := jsonb_set(_fail, array[_k, 'streak'], '0'::jsonb);
  end loop;
  for _k, _v in select key, value from jsonb_each(_err) loop
    _n := coalesce((_fail #>> array[_k, 'streak'])::int, 0) + 1;
    _fail := _fail || jsonb_build_object(_k, jsonb_build_object(
      'runs', coalesce((_fail #>> array[_k, 'runs'])::int, 0) + 1,
      'streak', _n,
      'max_streak', greatest(_n, coalesce((_fail #>> array[_k, 'max_streak'])::int, 0)),
      'first_at', coalesce(_fail #> array[_k, 'first_at'], to_jsonb(now())),
      'last_at', now(),
      'error', _v));
  end loop;

  -- graceful is not silent: one row a day per failing section
  for _k, _v in select key, value from jsonb_each(_err) loop
    if not exists (select 1 from public.admin_actions a
                    where a.action = 'challenge_task_tick_failed' and a.created_at >= _day_start and a.details->>'section' = _k) then
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_task_tick_failed', jsonb_build_object('section', _k, 'error', _v, 'at', now()));
    end if;
  end loop;
  if _out <> '{}'::jsonb then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_tick', _out || jsonb_build_object('date', _today, 'kicked', _kicked, 'at', now()));
  end if;

  insert into public.app_settings (key, value, description)
  values ('challenge_tasks_tick_state',
          jsonb_build_object('checked_at', now(), 'state', 'active', 'last_active_at', now(), 'done', _done,
                             'due', _due, 'kicked', _kicked,
                             'last_kick_at', case when _kicked then to_jsonb(now()) else coalesce(_prev->'last_kick_at', 'null'::jsonb) end,
                             'kicks_today', case when _kicked then 1 else 0 end
                               + case when _prev->'done'->>'date' = _today::text then coalesce((_prev->>'kicks_today')::int, 0) else 0 end,
                             'last_out', _out, 'errors', _err, 'failures', _fail),
          'Daily Tasks PR-5: heartbeat of cron challenge-tasks-tick (every minute). Written by challenge_tasks_tick().')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('state', 'active', 'out', _out, 'errors', _err, 'due', _due, 'kicked', _kicked);
end
$fn$;

-- ═══════════════════════════════ 6. The admin action behind PR-8's pre-step: one window identity sweep ═══════════════════════════════
create or replace function public.challenge_task_identity_sweep_request(_since timestamptz, _until timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- service_role / a migration: asks challenge-tasks-worker for ONE identity sweep over [_since, _until) of the daily
-- topics (challenge_task_identity_candidates WINDOW mode). Works while paused -- it is the go-live pre-step (G9) -- and
-- only links / registers accounts (resolveGroupPoster: the gated username link, then the provisional registrar with the
-- chat-admin exclusion); it never posts or DMs. The worker records 'challenge_task_identity_sweep' {linked, registered,
-- unresolved}; review the unresolved list before enabling.
declare
  _rid bigint;
begin
  if _since is null or (_until is not null and _until <= _since) then
    raise exception using errcode = '22023', message = 'challenge_task_identity_sweep_request: need _since (< _until)';
  end if;
  _rid := public.ops_net_post(
    p_url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/challenge-tasks-worker',
    p_body := jsonb_build_object('mode', 'identity_sweep', 'since', _since, 'until', _until),
    p_headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', public.cron_service_key(),
                                    'Authorization', 'Bearer ' || public.cron_service_key(),
                                    'x-internal-secret', public.internal_fn_secret()),
    p_purpose := 'challenge-tasks-worker',
    p_timeout_ms := 60000);
  insert into public.admin_actions (actor_user_id, action, details)
  values (auth.uid(), 'challenge_task_identity_sweep_requested', jsonb_build_object('since', _since, 'until', _until,
          'request_id', _rid, 'at', now()));
  return jsonb_build_object('ok', true, 'request_id', _rid);
end
$fn$;

-- ═══════════════════════════════ 7. Pinned rewrite: challenge_tasks_watchdog watches the tick and the worker ═══════════════════════════════
-- ONE anchor (the alarm de-duplication line), asserted to occur exactly once; the block is inserted before it. The
-- watchdog is independent of both legs it now watches (its own cron, its own DM path).
do $$
declare
  _pin constant text := '8425d0076060c3501094d611179baaa0';       -- live md5(prosrc), read 2026-09-30 (= the repo's PR-3 body)
  _new_pin constant text := 'ab091a8a4dfba493296490c558d6d198';    -- the rewritten body: this block applied to the LIVE
                                                                   -- body (read-only, 2026-09-30) = the PGlite harness
  _anchor constant text := E'  select coalesce(array_agg(distinct a), ''{}'') into _alarms from unnest(_alarms) a;\n';
  _block constant text :=
       E'  -- 20260930152010 (Daily Tasks PR-5): the per-minute tick and the worker, watched from here (independent of both)\n'
    || E'  begin\n'
    || E'    if coalesce((select (s.value->>''checked_at'')::timestamptz from public.app_settings s where s.key = ''challenge_tasks_tick_state''),\n'
    || E'                ''-infinity''::timestamptz) < _at - interval ''10 minutes'' then\n'
    || E'      _alarms := _alarms || ''tick_silent''::text;\n'
    || E'      _msgs := _msgs || ''Kunlik vazifalar taymeri (challenge_tasks_tick) 10 daqiqadan beri ishlamadi: post, DM va cheklar navbatda turibdi.''::text;\n'
    || E'    end if;\n'
    || E'    -- a tick section that failed on 3+ consecutive runs, its latest failure in the last hour (the tick''s failures memory)\n'
    || E'    select count(*)::int, string_agg(f.key || '': '' || left(coalesce(f.value->>''error'', ''?''), 80), ''; '' order by f.key)\n'
    || E'      into _n, _k\n'
    || E'      from public.app_settings s\n'
    || E'      cross join lateral jsonb_each(case when jsonb_typeof(s.value->''failures'') = ''object'' then s.value->''failures'' else ''{}''::jsonb end) f\n'
    || E'     where s.key = ''challenge_tasks_tick_state'' and jsonb_typeof(f.value) = ''object''\n'
    || E'       and coalesce((f.value->>''max_streak'')::int, 0) >= 3\n'
    || E'       and (f.value->>''last_at'')::timestamptz >= _at - interval ''60 minutes'';\n'
    || E'    if _n > 0 then\n'
    || E'      _alarms := _alarms || ''tick_errors''::text;\n'
    || E'      _msgs := _msgs || (''Kunlik vazifalar taymerida (challenge_tasks_tick) '' || _n || '' ta bo‘lim ketma-ket xato berdi: '' || left(_k, 200));\n'
    || E'    end if;\n'
    || E'    _n := (select count(*)::int from public.challenge_task_submissions s\n'
    || E'            where s.receipt_version > s.receipt_sent_version and s.receipt_state in (''pending'', ''sending'')\n'
    || E'              and s.updated_at < _at - interval ''30 minutes'');\n'
    || E'    if _n > 0 and coalesce((_cfg->>''receipts'')::boolean, true) then\n'
    || E'      _alarms := _alarms || ''worker_receipts''::text;\n'
    || E'      _msgs := _msgs || (_n || '' ta chek (receipt) 30 daqiqadan beri guruhga yuborilmagan (challenge-tasks-worker).'');\n'
    || E'    end if;\n'
    || E'    if coalesce((_cfg->>''dm'')::boolean, true)\n'
    || E'       and _lt >= coalesce((_cfg->>''quiet_end'')::time, time ''08:00'') + interval ''1 hour''\n'
    || E'       and _lt < coalesce((_cfg->>''quiet_start'')::time, time ''22:00'') then\n'
    || E'      _n := (select count(*)::int from public.challenge_task_outbox o\n'
    || E'              where o.state in (''pending'', ''sending'') and o.attempts < 5 and o.not_before < _at - interval ''60 minutes'');\n'
    || E'      if _n > 0 then\n'
    || E'        _alarms := _alarms || ''worker_dms''::text;\n'
    || E'        _msgs := _msgs || (_n || '' ta DM 1 soatdan beri yuborilmagan (challenge-tasks-worker).'');\n'
    || E'      end if;\n'
    || E'    end if;\n'
    || E'    _n := (select count(*)::int from public.admin_actions a\n'
    || E'            where a.action = ''challenge_task_worker_run'' and a.created_at >= _at - interval ''60 minutes''\n'
    || E'              and a.details->>''status'' = ''crashed'');\n'
    || E'    if _n > 0 then\n'
    || E'      _alarms := _alarms || ''worker_errors''::text;\n'
    || E'      _msgs := _msgs || (_n || '' marta challenge-tasks-worker xato bilan to‘xtadi (1 soatda).'');\n'
    || E'    end if;\n'
    || E'    -- 3+ worker runs in the last hour that finished with errors[] (e.g. a record RPC failing every run)\n'
    || E'    _n := (select count(*)::int from public.admin_actions a\n'
    || E'            where a.action = ''challenge_task_worker_run'' and a.created_at >= _at - interval ''60 minutes''\n'
    || E'              and a.details->>''status'' = ''partial'');\n'
    || E'    if _n >= 3 then\n'
    || E'      _alarms := _alarms || ''worker_partial''::text;\n'
    || E'      _msgs := _msgs || (_n || '' marta challenge-tasks-worker qisman xato bilan ishladi (1 soatda): ''\n'
    || E'                         || left(coalesce((select (a.details->''errors'')::text from public.admin_actions a\n'
    || E'                                            where a.action = ''challenge_task_worker_run'' and a.created_at >= _at - interval ''60 minutes''\n'
    || E'                                              and a.details->>''status'' = ''partial''\n'
    || E'                                            order by a.created_at desc limit 1), ''''), 150));\n'
    || E'    end if;\n'
    || E'  exception when others then\n'
    || E'    _alarms := _alarms || ''worker_watch_crashed''::text;\n'
    || E'    _msgs := _msgs || (''Taymer/ishchi kuzatuvi xato: '' || left(sqlerrm, 150));\n'
    || E'  end;\n'
    || E'\n';
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _fn := to_regprocedure('public.challenge_tasks_watchdog(timestamptz)');
  if _fn is null then
    raise exception 'ABORT: public.challenge_tasks_watchdog(timestamptz) not found';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef from pg_proc where oid = _fn;
  if position('challenge_tasks_tick_state' in _src) > 0 then      -- replay: the marker exists only after this rewrite
    raise notice 'challenge_tasks_watchdog already watches the tick -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: challenge_tasks_watchdog changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;
  _def := pg_get_functiondef(_fn);
  _n := (length(_def) - length(replace(_def, _anchor, ''))) / length(_anchor);
  if _n <> 1 then
    raise exception 'ABORT: challenge_tasks_watchdog anchor matched % times (want exactly 1)', _n;
  end if;
  _new := replace(_def, _anchor, _block || _anchor);
  execute _new;
  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: challenge_tasks_watchdog -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: challenge_tasks_watchdog -- owner, ACL or SECURITY DEFINER changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: challenge_tasks_watchdog -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 8. Grants: service_role only ═══════════════════════════════
-- anon and authenticated inherit PUBLIC, so every revoke names PUBLIC first.
revoke execute on function public.challenge_tasks_admin_dm(text, text) from public, anon, authenticated;
grant execute on function public.challenge_tasks_admin_dm(text, text) to service_role;
revoke execute on function public.challenge_task_identity_candidates(timestamptz, timestamptz, bigint[], integer) from public, anon, authenticated;
grant execute on function public.challenge_task_identity_candidates(timestamptz, timestamptz, bigint[], integer) to service_role;
revoke execute on function public.challenge_tasks_worker_due(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_tasks_worker_due(jsonb) to service_role;
revoke execute on function public.challenge_tasks_tick() from public, anon, authenticated;
grant execute on function public.challenge_tasks_tick() to service_role;
revoke execute on function public.challenge_task_identity_sweep_request(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_identity_sweep_request(timestamptz, timestamptz) to service_role;

-- ═══════════════════════════════ 9. Cron (inert while paused: a heartbeat stamp only) ═══════════════════════════════
do $$
declare _j record;
begin
  for _j in select jobid from cron.job where jobname = 'challenge-tasks-tick' loop
    perform cron.unschedule(_j.jobid);
  end loop;
end $$;
select cron.schedule('challenge-tasks-tick', '* * * * *', $c$ select public.challenge_tasks_tick() $c$);

-- ═══════════════════════════════ 10. Self-test (NON-mutating: catalog, ACLs, cron, the rewrite, two read-only calls) ═══════════════════════════════
-- Never calls the tick, the sweep request, the admin DM, a claim or a record; never posts.
do $$
declare
  _bad text[] := '{}';
  _r record;
  _cfg jsonb := public.challenge_tasks_config();
  _d jsonb;
  _c jsonb;
  _src text;
begin
  -- five functions, SECURITY DEFINER with a pinned search_path, never PUBLIC / anon / authenticated
  for _r in
    select p.oid::regprocedure::text as sig, p.prosecdef, coalesce(array_to_string(p.proacl, ','), '') as acl,
           coalesce(array_to_string(p.proconfig, ','), '') as conf
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('challenge_tasks_admin_dm', 'challenge_task_identity_candidates', 'challenge_tasks_worker_due',
                         'challenge_tasks_tick', 'challenge_task_identity_sweep_request')
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
         and p.proname in ('challenge_tasks_admin_dm', 'challenge_task_identity_candidates', 'challenge_tasks_worker_due',
                           'challenge_tasks_tick', 'challenge_task_identity_sweep_request')) <> 5 then
    _bad := _bad || 'functions_missing'::text;
  end if;
  -- the cron row, exactly
  if (select count(*) from cron.job
       where jobname = 'challenge-tasks-tick' and schedule = '* * * * *'
         and command = ' select public.challenge_tasks_tick() ') <> 1 then
    _bad := _bad || 'cron'::text;
  end if;
  -- every outbound call carries a Content-Type and goes through ops_net_post
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_tick()'::regprocedure);
  if (length(_src) - length(replace(_src, 'public.ops_net_post(', ''))) / length('public.ops_net_post(')
     <> (length(_src) - length(replace(_src, '''Content-Type'', ''application/json''', ''))) / length('''Content-Type'', ''application/json''') then
    _bad := _bad || 'tick_content_type'::text;
  end if;
  -- the pinned rewrite landed
  _src := (select prosrc from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure);
  if position('challenge_tasks_tick_state' in _src) = 0 or position('''tick_errors''' in _src) = 0
     or position('''worker_partial''' in _src) = 0 then
    _bad := _bad || 'watchdog_rewrite'::text;
  end if;
  -- the tick keeps the failures memory the watchdog reads
  if position('''failures'', _fail' in (select prosrc from pg_proc where oid = 'public.challenge_tasks_tick()'::regprocedure)) = 0 then
    _bad := _bad || 'tick_failures_memory'::text;
  end if;
  -- read-only, and gated on the CONFIG (never on the answer): while paused the kick must decide "do nothing"
  if not coalesce((_cfg->>'active')::boolean, false) then
    _d := public.challenge_tasks_worker_due(_cfg);
    if _d->>'state' is distinct from 'inactive' or coalesce((_d->>'total')::int, -1) <> 0 then
      _bad := _bad || ('due_while_paused:' || _d::text);
    end if;
  else
    raise notice 'challenge_tasks is active: the paused-kick self-test is skipped';
  end if;
  -- read-only: the sweep input answers its shape
  _c := public.challenge_task_identity_candidates(null, null, '{}', 1);
  if _c->>'mode' is distinct from 'regular' or jsonb_typeof(_c->'candidates') is distinct from 'array' then
    _bad := _bad || ('candidates_shape:' || left(_c::text, 200));
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: daily-tasks worker self-test failed: %', array_to_string(_bad, ', ');
  end if;
end $$;

-- ═══════════════════════════════ 11. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_tasks_worker_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_tasks_worker_applied', jsonb_build_object(
      'functions', jsonb_build_array('challenge_tasks_tick', 'challenge_tasks_worker_due', 'challenge_task_identity_candidates',
                                     'challenge_task_identity_sweep_request', 'challenge_tasks_admin_dm'),
      'cron', 'challenge-tasks-tick * * * * *',
      'edge_function', 'challenge-tasks-worker',
      'watchdog_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure),
      'config', (select jsonb_build_object('enabled', c->'enabled', 'active', c->'active', 'post', c->'post', 'dm', c->'dm')
                   from (select public.challenge_tasks_config() as c) x),
      'at', now()));
  end if;
end $$;
