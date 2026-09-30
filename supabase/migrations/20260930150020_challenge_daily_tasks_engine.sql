-- Challenge 6.0 daily tasks, PR-3: the SQL ENGINE (build spec v2 §6, §8, §9.2/9.6, §13). INERT at merge:
-- (This file re-issues 20260930150010 in slot 20260930150020 with the four review fixes R1-R4 below. 150010 had
-- re-issued 20260930150000: welcome receipts are queued -- never degraded -- over the per-chat budget, the 20:00
-- summary counts ride on post_claim, and a checked result is queued as a DM. Neither earlier slot was ever merged or
-- applied: 0 challenge_task_* objects exist live, re-checked 2026-09-30.)
-- platform_settings.challenge_tasks stays enabled=false / ai=false / miniapp=false (PR-1's seed; this file never
-- writes that row). While paused, nothing captures, awards, posts, sends or calls an AI; the two new cron jobs write a
-- heartbeat / a watchdog state stamp ONLY. Go-live is PR-8.
--
-- ═══ WHAT THIS DOES ═══
-- 1. Tables (RLS on, service_role only; every user_id -> profiles ON DELETE CASCADE, G24):
--    challenge_task_submissions (one live row per student+task: needs_more|checking|accepted; ig_handle_snapshot,
--    hold_reason ai_off|ig_waiting_ai, receipt state machine, check lease, freeze stamps), challenge_task_messages
--    (the processed-message LEDGER: one final row per captured daily-topic message, with reason / resolved_via),
--    challenge_ig_posts (a post link earns once, ever), challenge_task_streak_awards (sticky), challenge_task_outbox
--    (DMs for PR-5), challenge_task_submit_claims (Mini App request claims, G28), challenge_task_ai_calls (cost
--    ledger), challenge_task_retry (the DB-visible retry state of NO-ROW outcomes, I4 -- d5).
-- 2. ONE engine decides (I1): challenge_task_capture(msg, source[, opts]) -- topic (chat AND thread, never the
--    thread alone: thread 10 is the daily topic of both 5- and 6-GURUH), pause (C20: 'disabled', no row),
--    window by DATES, sender (anonymous / bot / staff / telegram_id / same-group username_match C19 / unknown /
--    HELD no_group|sender_out_of_scope|inactive C23 / wrong_group / voided), the C18 comment rule, daily cap, and
--    OPTION-1 attribution R1 album, R2 reply-to-own, R3 reply-to-task-post (incl. MANUAL posts), R4 burst, R5
--    fix-up, R6 new slot ((a) IG affinity, (b) today, (c) missed -- G3 create rule; text never fills a missed
--    task), R7, back-burst adoption; then evaluate (§6.7), settle (§8), legacy swap (§6.8). It returns the
--    render-ready payload the bot (PR-4) and Mini App (PR-7) only render.
--    challenge_task_item_edited (C17), the Mini App entries prepare / submit_claim / submit_record /
--    capture_miniapp (submitted_at = CLAIM time, G28), corrections move (+merge) / withdraw / restore with _by_tg
--    (the owner lock in SQL, logged admin override) and my_* for the web/Mini App, challenge_task_card
--    (/start dt_<id>), my_challenge_tasks, my_telegram_write_access_granted (C15), admin_challenge_task_results /
--    admin_challenge_task_override (audited appeals), challenge_task_reassign_user (G24).
-- 3. Points (§8): challenge_task_settle_ut is the ONLY writer of 'ch_task:<task>' (reason challenge_task):
--    general 5 / instagram 8 (config), late 1..2 days = ceil(half) (3 / 4), closed after 2 days; freeze-aware
--    created_at (C11: a frozen week -> now()); per-student locks ctask:<u> THEN user_xp:<u>, rebuilding only that
--    student (G31). Streak: +10 per 5 consecutive ON-TIME task days (rest days skipped, late work breaks the run,
--    sticky), 'ch_task_streak:<date>' (reason challenge_task_streak); every award CLAIMS the 5 days that paid it, so
--    a day pays toward one award at most, however the run is later split or re-joined (R2).
-- 4. Workers' claim / record RPCs (inert while paused): AI check claim / record (SQL decides from LABELS, I3;
--    general default-pay, instagram handle / tag / recency / 404 / dHash near-duplicate, never fail-open), receipt
--    claim / record, post claim / record (+ the anonymous 20:00 summary counts and the dt_<id> start parameter),
--    outbox claim / record (quiet hours; a checked verdict queues a 'result' DM for a DM-eligible student),
--    identity_pending (PR-5's sweep).
-- 5. reconcile_challenge_tasks (cron 'challenge-tasks-reconcile' 4-59/10): a FIXED 26-hour rolling capture scan
--    anti-joined on the ledger (C21), hold release + general fail-open (ai=true only), handle re-evaluation, Mini
--    App heal, ledger heal (voids, drift, orphans, streak), expire. challenge_tasks_backfill(_from, _to) for
--    retro credit (receipts suppressed, summary DMs queued, unresolved senders reported, G9).
-- 6. challenge_tasks_health() and challenge_tasks_watchdog() (cron 'challenge-tasks-watchdog' :47): every §13
--    counter; alarms only on TASK days for calendar rules (I10), 24-h dedupe per alarm, recovery DM only after an
--    alert went out, DMs to <= 3 admins through ops_net_post with Content-Type.
-- 7. Guards as their OWN triggers (d1, d2): trg_challenge_tasks_zz_lock (guard v2: what a submission was judged
--    against is frozen once posted or submitted) and trg_profiles_zz_ig_handle_lock (G2: the Instagram handle is
--    locked after the first accepted instagram task; admins / definers pass).
-- 8. ONE pinned rewrite: xp_award_integrity_watchdog gains challenge_chat, challenge_answer, challenge_task,
--    challenge_task_streak in unverifiable_by_design (G31; §6.14d). Live md5 0a7c5bae..., new 71500fc1...
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * PR-0 (20260930120020), PR-1 (20260930121000), #221 (20260930130549) and PR-2 (20260930122010) are applied: all
--   six AC CHALLENGE groups have a daily topic (1:144, 2:99, 3:38, 4:12, 5:10, 6:10 -- 5 and 6 share thread 10 in
--   different chats), 0 profiles in them, 0 challenge_task* rows, 0 'ch_task' ledger rows.
-- * platform_settings.challenge_tasks = PR-1's seed (enabled false, ai false, miniapp false; parses with no invalid
--   key). challenge: enabled true, window.start 2026-10-01T00:00+05, end null, course_ids [6.0].
-- * xp_award_integrity_watchdog md5(prosrc) 0a7c5bae4e1ff1d6e8eb667c39af0335 (fixture
--   supabase/functions/_challenge/testing/xp_award_integrity_watchdog.live-2026-09-30.sql, md5-identical);
--   ACL postgres + service_role, SECURITY DEFINER.
-- * freeze_challenge_week (md5 e676d00e2c1fdac5436a479c5957f1c6) writes challenge_weekly_results.week_start + the
--   audit row 'challenge_week_frozen' {week} under TWO keys: a manual run stores the Monday; the weekly cron (job
--   'challenge-weekly', 10 4 * * 1 -> challenge_weekly_job() -> freeze_challenge_week()) stores `_prev_mon::date`, a
--   timestamptz (Monday 00:00 +05) cast in the server's UTC session (TimeZone = UTC from the configuration file, no
--   role / database override) = the SUNDAY before (at 2026-10-12 04:10 UTC it evaluates to 2026-10-04). R4 reads
--   both. admin_void_challenge_points writes 'challenge_points_voided' (target_user_id).
-- * xp_events: UNIQUE (user_id, ref_key), amount > 0, FK auth.users. profiles.telegram_username / instagram_username
--   are citext (both globally unique). PG 17 (bit_count), citext installed, fuzzystrmatch NOT installed (own
--   Levenshtein). webhook_inbox carries message_thread_id / from_user_id (always filled for messages).
-- * Profiles triggers: trg_profiles_normalize_instagram, trg_profiles_zz_column_guard (PR-0), zz_instagram_audit
--   (AFTER). Cron minutes 4-59/10 and :47 are free.
--
-- ═══ DEVIATIONS FROM THE SPEC (each argued; the PR body repeats them) ═══
-- d1  Guard v2 is a SEPARATE trigger (trg_challenge_tasks_zz_lock, after v1 by name) instead of rewriting PR-2's
--     challenge_tasks_guard: v1 stays byte-identical. It also freezes min_text_chars / min_duration_sec, refuses
--     approved -> draft, and audits cancel / un-cancel ('challenge_task_status_changed_with_submissions'). A
--     cancelled task pays 0: the next reconcile removes its points; re-approving restores them.
-- d2  profiles_column_guard "v2" is a SEPARATE invoker trigger (trg_profiles_zz_ig_handle_lock) + a definer helper
--     that answers only about the caller: PR-0's security guard is not rewritten at all.
-- d3  [WITHDRAWN in 150020, R1] 150010 kept new MEDIA out of an ACCEPTED submission's burst; with ai=false that paid
--     a missed day's late points for the second screenshot of TODAY's work. R4 now follows the spec (see R1).
-- d4  is_task_day: an approved task date, or a configured weekday ON OR AFTER the first approved task date, inside
--     the window dates. The owner's first task day is Monday 2026-10-05: Thu 10-01 / Fri 10-02 never alarm.
-- d5  challenge_task_retry is added (the spec's I4 "DB-visible retry state"); written only by the reconciler /
--     backfill, deleted on capture, purged after 7 days.
-- d6  capture takes an optional 3rd argument _opts {welcome} (the bot's auto-register flag, G7) -- additive.
-- d7  challenge_task_ai_calls.user_id is ON DELETE SET NULL (a cost ledger outlives the student); group_id FKs are
--     SET NULL (deleting a group never deletes scored history).
-- d8  R2 / R3 append only while the task is OPEN; after close_at an accepted submission gets 'appended_extra' and a
--     needs_more one gets nothing -- late work is never completed after the task closed (I5).
-- d9  R3 (a reply to a task post) creates without the G3 create rule (the spec states it under R6 only): explicit
--     targeting wins; the submission stays needs_more until requires is met, so nothing pays early.
-- d10 ai=false pays on format only when a requires group that lists a MEDIA kind is met by media ("a met media
--     group", C16): a photo attached to a text-only task is still held.
-- d11 The AI verdict schemas (strict, exact keys) are defined HERE as the contract PR-6 builds to
--     (challenge_task_verdict_valid); handle_seen NULL -> 'ig_handle_not_visible'.
-- d12 Config: an ABSENT key takes its default silently; a present-but-bad key takes the default and is listed in
--     invalid[]; a cap <= 0 is invalid (default); points / streak <= 0 switch that signal off.
-- d13 Instagram /share/ links never yield a shortcode (the token is not the media code, G10).
-- d14 my_challenge_tasks lists approved tasks up to today plus any task the student already has work for.
-- d15 A Mini App refusal (held / staff / wrong course) is FINAL: the claim is marked failed and signalled, so the
--     heal never loops on it.
-- d16 An extra alarm 'unknown_senders' (>= 3 distinct shaped unknown senders unresolved for 2 h): a broken
--     auto-register path would otherwise be silent. reconcile / health / watchdog take _at DEFAULT now() for the
--     harness's fixed clock (cron passes nothing).
-- d17 my_telegram_write_access_granted() is created here (G12 lists it for PR-7's impersonation guard; the column
--     exists since PR-0).
--
-- ═══ REVIEW FIXES (150020; each reproduced on PGlite against 150010 first -- harness section RV) ═══
-- R1  BURST (spec §6.5 R4): media inside merge_window_min joins the newest live submission INCLUDING an accepted one
--     ('appended', a 👍 reaction). 150010's d3 let the 2nd screenshot of today's work -- Telegram users often send
--     screenshots one by one -- create a MISSED day that ai=false paid on format (+3 per open missed day). A missed
--     day is still filled by the next post after the window (option 1) or explicitly by replying to that day's post
--     (R3). Detector: health.missed_within_burst_7d counts missed slots created inside another submission's burst
--     window (only a kind today's task does not accept can still do that).
-- R2  STREAK awards are sticky, and each one now CLAIMS (claimed_dates) the `every` on-time days that paid it. A new
--     award is written only when a maximal on-time run holds `every` on-time days no award has claimed, so a run of
--     L days is paid floor(L / every) times however it was split / re-joined (withdraw -> restore, held checks
--     released later, reassign). 150010 recomputed positions from scratch and never counted the sticky awards: +10
--     extra per withdraw / restore, 3 awards for 10 days after held checks were released. Detector: invariant
--     streak_awards_excess (an award whose claimed days overlap another's) -> the watchdog's 'invariant' alarm. (A
--     run-length check was rejected: a sticky award legitimately outlives a later split -- cancel, admin reject, void.)
-- R3  CORRECTIONS: a STUDENT (the owner via the bot, or my_* in the app) can no longer move or withdraw a REJECTED
--     submission ('rejected_final' -- an appeal is an admin override), restore a submission an ADMIN withdrew
--     ('withdrawn_by_admin'), or correct anything once now() >= close_at of the source or target task ('closed').
--     Restore returns the status (and reason) recorded at withdraw time instead of re-judging (a restored 'checking'
--     gets a fresh check lease and fail-open clock). A withdrawn rejected attempt still counts toward
--     max_attempts_per_task (challenge_task_rejected_count). Admins keep every override (logged).
-- R4  FROZEN WEEK: challenge_task_week_frozen_at() reads both keys the freeze writes (the Monday and the Sunday
--     before it, see VERIFIED LIVE); award_ts and health.awards_after_freeze_7d use it, and the detector now covers
--     streak awards too. Fixing freeze_challenge_week's own key is left to a separately pinned migration (it feeds
--     the weekly boards; not this PR's slice) -- the engine accepts both keys either way.
--
-- ═══ CONTRACTS the later PRs must honour (health reads them) ═══
-- PR-4 (bot): call challenge_task_capture(msg, 'topic', {welcome}) first in the daily topic (fail CLOSED to today's
-- behaviour if the RPC is missing); record receipts with challenge_task_receipt_record; write admin_actions
-- 'challenge_bot_status_changed' {chat, old_status, new_status, can_delete_messages, can_manage_topics},
-- 'challenge_task_topic_missing', 'telegram_rate_limited', 'challenge_task_misplaced_homework' (a picker auto-tag in
-- a challenge-scope homework topic -- not DB-visible today), 'challenge_task_capture_failed'. PR-5: the tick queues
-- challenge_task_posts / outbox; the worker uses the claim RPCs and writes 'challenge_task_identity_sweep'
-- {linked, registered, unresolved}. PR-6: challenge_task_check_claim / _record with the d11 schemas.
-- PR-4 / PR-7 (corrections, R3): move / withdraw / restore answer {ok:false, reason} with 'rejected_final',
-- 'withdrawn_by_admin' or 'closed' (besides not_found / not_owner / future_task / same_task / bad_target /
-- too_many_moves / attempts_exhausted / slot_taken / not_movable / not_withdrawable / not_withdrawn): each is a
-- friendly Uzbek line for the student (member forgiveness), never an error.
--
-- ═══ KILL-SWITCHES ═══
-- platform_settings.challenge_tasks.enabled = false is a PAUSE (no row; the rolling scan re-derives the last 26 h on
-- resume; older needs challenge_tasks_backfill). challenge.enabled = false pauses too. ai = false holds text-only
-- and instagram work. Clearing a group's daily-topic URL opts it out. Last resort: cron.unschedule both jobs AND
-- delete app_settings 'challenge_tasks_watchdog_state' (the out-of-band verifier watches every *_watchdog_state).
--
-- ═══ DETECTION ═══
-- challenge_tasks_health(): retry / held / unknown / username_match_unlinked / paused / bot status / liveness /
-- posts / held checks / checks / AI / receipts / outbox / Mini App / legacy swaps / handle changes / IG unverified /
-- fingerprint unavailable / misplaced homework / missed slots created inside a burst, and invariants (ledger_drift,
-- streak_awards_without_xp, streak_awards_excess, topic_points_leak_24h incl. community help/question,
-- awards_after_freeze_7d incl. streak awards, live_duplicates).
-- challenge_tasks_watchdog() alarms on them hourly; every run leaves 'challenge_tasks_watchdog_run'.
--
-- SELF-TEST: non-mutating only -- pure / IMMUTABLE fixtures (classify incl. the forum-topic reply farm, requires
-- eval, the create rule, the C18 comment rule, Levenshtein, dHash, verdict schemas, the ?thread= parser, the
-- requires validator), catalog / ACL / RLS / FK / trigger / cron presence, the rewritten md5, the live config parse.
-- It never calls capture, settle, reconcile, the watchdog, backfill, a claim or reassign.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-engine-check.ts (#218 + PR-1 + PR-2 + THIS file
-- on the live fixtures, incl. the LIVE freeze_challenge_week, under a pinned clock): attribution, late, streak,
-- freeze, corrections, pause/resume, held, race safety, edits, legacy swap, Mini App, reassign, AI record, fail-open,
-- expire, health, watchdog, guards, backfill, replay, and the RV review regressions.
-- Merge: after PR-2 (20260930122010, ledgered). Label migration-approved, NEVER ops-agent. One at a time.

-- ═══════════════════════════════ 0. Prerequisites: PR-0 (profiles columns) and PR-2 (the calendar) ═══════════════════════════════
do $$
begin
  if to_regclass('public.challenge_tasks') is null or to_regclass('public.challenge_task_posts') is null
     or to_regprocedure('public.challenge_task_topics()') is null
     or to_regprocedure('public.challenge_task_render_post(public.challenge_tasks)') is null
     or to_regprocedure('public.challenge_task_requires_valid(jsonb)') is null then
    raise exception 'ABORT: 20260930122010 (Daily Tasks PR-2: challenge_tasks / challenge_task_posts) must be applied first';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name in ('telegram_write_access_at', 'instagram_username', 'telegram_username', 'account_type')) <> 4 then
    raise exception 'ABORT: profiles.telegram_write_access_at / instagram_username / telegram_username / account_type missing (PR-0 20260930120020)';
  end if;
  if to_regprocedure('public.challenge_social_staff_ids()') is null or to_regprocedure('public.challenge_config()') is null then
    raise exception 'ABORT: #218 (20260930100010: challenge_social_staff_ids) must be applied first';
  end if;
  if not exists (select 1 from pg_type where typname = 'citext') then
    raise exception 'ABORT: the citext extension is required (profiles.instagram_username is citext)';
  end if;
end $$;

-- ═══════════════════════════════ 1. Tables (RLS on, service_role only; every user_id cascades with its profile) ═══════════════════════════════
create table if not exists public.challenge_task_submissions (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.challenge_tasks(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid references public.groups(id) on delete set null,
  source text not null check (source in ('topic', 'miniapp', 'reconciler', 'backfill', 'admin')),
  attributed_via text not null
    check (attributed_via in ('today', 'missed', 'reply_to_post', 'ig_link', 'burst', 'fixup', 'miniapp', 'moved', 'admin')),
  status text not null default 'needs_more'
    check (status in ('needs_more', 'checking', 'accepted', 'rejected', 'withdrawn', 'merged', 'voided', 'expired')),
  missing text[] not null default '{}',
  reason text,
  hold_reason text check (hold_reason is null or hold_reason in ('ai_off', 'ig_waiting_ai')),
  submitted_at timestamptz not null,            -- the Telegram date of the FIRST item (Mini App: the claim time). I5.
  last_item_at timestamptz not null,
  late_days integer not null default 0 check (late_days >= 0),
  points_awarded integer not null default 0 check (points_awarded >= 0),
  attempt_no integer not null default 1 check (attempt_no >= 1),
  ig_shortcode text,
  ig_handle_snapshot citext,                    -- the handle when the instagram submission became complete (G2)
  check_version integer not null default 0,
  checking_since timestamptz,                   -- when it (re)entered 'checking' with no hold: the fail-open clock
  check_token uuid,
  check_claimed_at timestamptz,
  check_attempts integer not null default 0,
  checked_version integer,
  checked_at timestamptz,
  check_result jsonb,
  accepted_at timestamptz,
  xp_created_at timestamptz,                    -- the created_at the ledger row got (freeze-aware, C11)
  awarded_at timestamptz,                       -- when that ledger row was written
  receipt_state text not null default 'none'
    check (receipt_state in ('none', 'pending', 'sending', 'sent', 'suppressed', 'failed')),
  receipt_version integer not null default 0,
  receipt_sent_version integer not null default 0,
  receipt_chat_id bigint,
  receipt_message_id bigint,
  receipt_reply_to bigint,
  receipt_token uuid,
  receipt_claimed_at timestamptz,
  receipt_requested_at timestamptz,
  receipt_carries_welcome boolean not null default false,
  receipt_error text,
  moved_count integer not null default 0 check (moved_count >= 0),
  merged_into bigint references public.challenge_task_submissions(id) on delete set null,
  request_id text,
  -- R3: what a withdraw recorded, so restore returns it (never a re-judge) and knows who withdrew
  withdrawn_from text check (withdrawn_from is null or withdrawn_from in ('needs_more', 'checking', 'accepted', 'rejected')),
  withdrawn_reason text,
  withdrawn_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_ctask_sub_live on public.challenge_task_submissions (user_id, task_id)
  where status in ('needs_more', 'checking', 'accepted');
create unique index if not exists uq_ctask_sub_request on public.challenge_task_submissions (user_id, request_id)
  where request_id is not null;
create index if not exists idx_ctask_sub_task on public.challenge_task_submissions (task_id, status);
create index if not exists idx_ctask_sub_user on public.challenge_task_submissions (user_id, last_item_at desc);
create index if not exists idx_ctask_sub_checking on public.challenge_task_submissions (last_item_at) where status = 'checking';
create index if not exists idx_ctask_sub_receipt on public.challenge_task_submissions (receipt_chat_id, receipt_message_id)
  where receipt_message_id is not null;
create index if not exists idx_ctask_sub_group on public.challenge_task_submissions (group_id, submitted_at);

create table if not exists public.challenge_task_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  message_id bigint not null,
  thread_id bigint,
  group_id uuid references public.groups(id) on delete set null,
  user_id uuid references public.profiles(id) on delete cascade,
  tg_user_id bigint,
  sent_at timestamptz not null,                 -- the message's own Telegram date
  outcome text not null check (outcome in (
    'created', 'appended', 'appended_album', 'appended_extra', 'adopted',
    'comment', 'ignored_kind', 'forward_other', 'staff', 'anonymous', 'bot',
    'wrong_group', 'voided_sender', 'outside_window', 'daily_cap', 'no_slot', 'attempts_exhausted')),
  reason text,
  resolved_via text check (resolved_via is null or resolved_via in ('telegram_id', 'username_match', 'miniapp')),
  submission_id bigint references public.challenge_task_submissions(id) on delete set null,
  kinds text[] not null default '{}',
  file_ids text[] not null default '{}',
  item jsonb not null default '{}'::jsonb,
  media_group_id text,
  is_real_reply boolean not null default false,
  reply_to_message_id bigint,
  reply_kind text,
  source text not null check (source in ('topic', 'miniapp', 'reconciler', 'backfill')),
  hinted boolean not null default false,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_ctask_msg unique (chat_id, message_id)
);
create index if not exists idx_ctask_msg_user on public.challenge_task_messages (user_id, sent_at);
create index if not exists idx_ctask_msg_sub on public.challenge_task_messages (submission_id);
create index if not exists idx_ctask_msg_group on public.challenge_task_messages (group_id, sent_at);
create index if not exists idx_ctask_msg_album on public.challenge_task_messages (chat_id, media_group_id) where media_group_id is not null;
create index if not exists idx_ctask_msg_files on public.challenge_task_messages using gin (file_ids);

create table if not exists public.challenge_ig_posts (
  shortcode text primary key,                   -- a post link earns once, ever
  user_id uuid not null references public.profiles(id) on delete cascade,
  submission_id bigint references public.challenge_task_submissions(id) on delete set null,
  task_id bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.challenge_task_streak_awards (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null,
  task_date date not null,                      -- the task date that completed the run
  streak_len integer not null check (streak_len > 0),
  bonus integer not null check (bonus > 0),
  xp_ref_key text not null,
  claimed_dates date[] not null check (cardinality(claimed_dates) > 0),   -- R2: the on-time days that paid this award
  created_at timestamptz not null default now(),
  constraint uq_ctask_streak unique (user_id, course_id, task_date)
);

create table if not exists public.challenge_task_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('morning', 'evening', 'result', 'backfill_summary')),
  task_id bigint,
  submission_id bigint references public.challenge_task_submissions(id) on delete set null,
  dedupe_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  not_before timestamptz not null default now(),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_ctask_outbox_due on public.challenge_task_outbox (not_before) where state in ('pending', 'sending');

create table if not exists public.challenge_task_submit_claims (
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id text not null check (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  task_id bigint not null references public.challenge_tasks(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  state text not null default 'claimed' check (state in ('claimed', 'posted', 'captured', 'failed', 'abandoned')),
  items jsonb,
  submission_id bigint references public.challenge_task_submissions(id) on delete set null,
  error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, request_id)
);

create table if not exists public.challenge_task_ai_calls (
  id bigint generated always as identity primary key,
  submission_id bigint references public.challenge_task_submissions(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,   -- a cost ledger outlives the student (d7)
  provider text,
  model text,
  prompt_version text,
  status text not null default 'ok',
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ctask_ai_calls_time on public.challenge_task_ai_calls (created_at);

-- The DB-visible retry state for NO-ROW outcomes (I4): written only by the reconciler / backfill, deleted when the
-- message is finally captured. Health and the watchdog read it; nothing pays from it.
create table if not exists public.challenge_task_retry (
  chat_id bigint not null,
  message_id bigint not null,
  thread_id bigint,
  group_id uuid,
  tg_user_id bigint,
  tg_username text,
  message_at timestamptz,
  outcome text not null,
  reason text,
  shaped boolean not null default false,
  attempts integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
create index if not exists idx_ctask_retry_last on public.challenge_task_retry (last_at);

comment on table public.challenge_task_submissions is
  'Daily Tasks PR-3: one row per student attempt at a task. Live = needs_more|checking|accepted (one per user+task). '
  'Points are a pure function of (task, the Tashkent date of submitted_at, status) -- written only by challenge_task_settle_ut.';
comment on table public.challenge_task_messages is
  'Daily Tasks PR-3: the processed-message ledger. Every captured daily-topic message has exactly one row (final outcome); '
  'no-row outcomes (disabled, unknown_sender, held, error) live in challenge_task_retry until the rolling scan captures them.';

-- ═══════════════════════════════ 2. Pure helpers (IMMUTABLE; the self-test runs them on fixtures) ═══════════════════════════════
create or replace function public.challenge_task_accepts_kind(_k text)
returns text
language sql
immutable
set search_path = public
as $fn$
  -- An item kind in the requires vocabulary -> the accepts vocabulary (the same map challenge_task_requires_problem uses).
  select case _k when 'image_doc' then 'document' when 'video_doc' then 'document' when 'ig_link' then 'link' else _k end
$fn$;

create or replace function public.challenge_task_classify(_m jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
-- A Telegram Message object -> the facts the engine decides on. Pure: no table is read.
--   kinds       subset of text, photo, image_doc, video, video_doc, document, voice, video_note, audio, link, ig_link
--               (image_doc / video_doc = a document whose mime is image/* / video/*; a GIF, sticker, poll or service
--               message has NO kind -> ignored_kind). A caption is text.
--   text_len    characters of text/caption with every URL removed (a bare link is not "text").
--   shortcode   the first instagram.com/(p|reel|reels|tv)/<code>; ig_share = an instagram.com/share/ link (G10).
--   is_real_reply  Telegram makes every forum-topic post a reply to the topic-creation message (whose id IS the
--               thread id): that is NOT a reply (the forum-topic reply farm lesson).
--   question    text-only, no link, and ends with '?' (< 120 chars) or opens with a question word (< 60 chars).
declare
  _url_re constant text := '(https?://[^[:space:]<>"]+|www\.[^[:space:]<>"]+|t\.me/[^[:space:]<>"]+|instagram\.com/[^[:space:]<>"]+)';
  _media_kinds constant text[] := array['photo', 'image_doc', 'video', 'video_doc', 'document', 'voice', 'video_note', 'audio'];
  _text text;
  _ents jsonb;
  _urls text[] := '{}';
  _u text;
  _e jsonb;
  _kinds text[] := '{}';
  _mime text;
  _sc text;
  _ig_share boolean := false;
  _text_len int;
  _dur int;
  _files text[] := '{}';
  _thumb boolean := false;
  _thread bigint;
  _from bigint;
  _r jsonb;
  _real_reply boolean := false;
  _fwd boolean;
  _fwd_other boolean := false;
  _q boolean := false;
  _media boolean;
  _t text;
begin
  if _m is null or jsonb_typeof(_m) <> 'object' then
    return jsonb_build_object('kinds', '[]'::jsonb, 'text_len', 0, 'media', false, 'text_only', false, 'link', false,
                              'ig_link', false, 'ig_share', false, 'file_ids', '[]'::jsonb, 'question', false,
                              'forward', false, 'forward_other', false, 'is_real_reply', false);
  end if;
  _text := coalesce(case when jsonb_typeof(_m->'text') = 'string' then _m->>'text' end,
                    case when jsonb_typeof(_m->'caption') = 'string' then _m->>'caption' end, '');
  _ents := case when jsonb_typeof(_m->'entities') = 'array' then _m->'entities'
                when jsonb_typeof(_m->'caption_entities') = 'array' then _m->'caption_entities'
                else '[]'::jsonb end;
  select coalesce(array_agg(x[1]), '{}') into _urls from regexp_matches(_text, _url_re, 'gi') x;
  for _e in select value from jsonb_array_elements(_ents) loop
    if jsonb_typeof(_e) = 'object' and _e->>'type' = 'text_link' and coalesce(_e->>'url', '') <> '' then
      _urls := _urls || (_e->>'url');
    end if;
  end loop;
  foreach _u in array _urls loop
    if _u ~* 'instagram\.com/share/' then
      _ig_share := true;                        -- /share/<token> is NOT the media shortcode (G10): never used as one
      continue;
    end if;
    if _sc is null then
      _sc := (regexp_match(_u, '(?:instagram\.com|instagr\.am)/(?:[A-Za-z0-9_.]{1,30}/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]{5,40})', 'i'))[1];
    end if;
  end loop;
  _text_len := char_length(btrim(regexp_replace(_text, _url_re, '', 'gi'), E' \t\r\n'));

  if jsonb_typeof(_m->'photo') = 'array' and jsonb_array_length(_m->'photo') > 0 then
    _kinds := _kinds || 'photo'::text;
    if coalesce(_m->'photo'->-1->>'file_unique_id', '') <> '' then
      _files := _files || (_m->'photo'->-1->>'file_unique_id');
    end if;
  end if;
  if _m ? 'animation' or _m ? 'sticker' then
    null;                                       -- a GIF / sticker (Telegram also sets document for a GIF): chatter
  elsif jsonb_typeof(_m->'document') = 'object' then
    _mime := lower(coalesce(_m->'document'->>'mime_type', ''));
    _kinds := _kinds || (case when _mime like 'image/%' then 'image_doc' when _mime like 'video/%' then 'video_doc' else 'document' end);
    if coalesce(_m->'document'->>'file_unique_id', '') <> '' then _files := _files || (_m->'document'->>'file_unique_id'); end if;
    _thumb := _thumb or jsonb_typeof(_m->'document'->'thumbnail') = 'object' or jsonb_typeof(_m->'document'->'thumb') = 'object';
  end if;
  if jsonb_typeof(_m->'video') = 'object' then
    _kinds := _kinds || 'video'::text;
    _dur := case when (_m->'video'->>'duration') ~ '^[0-9]{1,6}$' then (_m->'video'->>'duration')::int end;
    if coalesce(_m->'video'->>'file_unique_id', '') <> '' then _files := _files || (_m->'video'->>'file_unique_id'); end if;
    _thumb := _thumb or jsonb_typeof(_m->'video'->'thumbnail') = 'object' or jsonb_typeof(_m->'video'->'thumb') = 'object';
  end if;
  foreach _t in array array['voice', 'video_note', 'audio'] loop
    if jsonb_typeof(_m->_t) = 'object' then
      _kinds := _kinds || _t;
      _dur := coalesce(_dur, case when (_m->_t->>'duration') ~ '^[0-9]{1,6}$' then (_m->_t->>'duration')::int end);
      if coalesce(_m->_t->>'file_unique_id', '') <> '' then _files := _files || (_m->_t->>'file_unique_id'); end if;
    end if;
  end loop;
  if btrim(_text, E' \t\r\n') <> '' then
    _kinds := _kinds || 'text'::text;
  end if;
  if cardinality(_urls) > 0 then
    _kinds := _kinds || 'link'::text;
  end if;
  if _sc is not null then
    _kinds := _kinds || 'ig_link'::text;
  end if;
  _media := _kinds && _media_kinds;

  _from := case when (_m->'from'->>'id') ~ '^[0-9]{1,19}$' then (_m->'from'->>'id')::bigint end;
  _fwd := _m ? 'forward_origin' or _m ? 'forward_from' or _m ? 'forward_from_chat' or _m ? 'forward_sender_name' or _m ? 'forward_date';
  if _fwd then
    _fwd_other := not coalesce((_m->'forward_origin'->>'type' = 'user' and _m->'forward_origin'->'sender_user'->>'id' = _from::text)
                               or (_m->'forward_from'->>'id' = _from::text), false);
  end if;

  _thread := case when (_m->>'message_thread_id') ~ '^[0-9]{1,19}$' then (_m->>'message_thread_id')::bigint end;
  _r := case when jsonb_typeof(_m->'reply_to_message') = 'object' then _m->'reply_to_message' end;
  _real_reply := _r is not null and not (_r ? 'forum_topic_created')
                 and (_r->>'message_id') is distinct from _thread::text;

  _q := not _media and cardinality(_urls) = 0 and char_length(btrim(_text)) between 1 and 119
        and (btrim(_text) ~ '[?？][^[:space:]]{0,3}$'
             or (char_length(btrim(_text)) < 60
                 and lower(btrim(_text)) ~ '^(qanday|qanaqa|qachon|nima|nega|nimaga|qayer|qayerda|qaysi|kim|necha|qancha|how|what|why|when|where|which|who|как|что|почему|зачем|когда|где|какой|какая|сколько)([[:space:],.!?:;]|$)'));

  return jsonb_build_object(
    'kinds', to_jsonb(_kinds),
    'text_len', _text_len,
    'media', _media,
    'text_only', not _media and cardinality(_kinds) > 0,
    'link', cardinality(_urls) > 0,
    'ig_link', _sc is not null,
    'ig_share', _ig_share,
    'shortcode', _sc,
    'duration', _dur,
    'file_ids', to_jsonb(_files),
    'has_thumb', _thumb,
    'mime', _mime,
    'media_group_id', case when jsonb_typeof(_m->'media_group_id') = 'string' then _m->>'media_group_id' end,
    'forward', coalesce(_fwd, false),
    'forward_other', _fwd_other,
    'is_real_reply', _real_reply,
    'reply_to_message_id', case when _real_reply and (_r->>'message_id') ~ '^[0-9]{1,19}$' then (_r->>'message_id')::bigint end,
    'reply_from_id', case when _real_reply and (_r->'from'->>'id') ~ '^[0-9]{1,19}$' then (_r->'from'->>'id')::bigint end,
    'reply_from_is_bot', case when _real_reply then coalesce((_r->'from'->>'is_bot')::boolean, false) else false end,
    'reply_from_anon', case when _real_reply then (_r ? 'sender_chat' or _r->'from'->>'id' = '1087968824') else false end,
    'question', _q,
    'date', case when (_m->>'date') ~ '^[0-9]{1,12}$' then (_m->>'date')::bigint end,
    'text', left(_text, 4000));
end
$fn$;

create or replace function public.challenge_task_requires_eval(
  _type text, _requires jsonb, _accepts text[], _items jsonb, _min_text integer, _min_dur integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
-- Deterministic completeness (§6.7). _items = the classified items counted for a submission. A group is met when
--   (#non-text items whose kind is in the group) + (1 if the group lists text AND the total text chars >= _min_text)
--   >= min. Voice / video_note / audio count only when at least _min_dur seconds long. requires = [] = any one
-- accepted item. Returns {complete, missing[labels], media, media_met, ai_visible, text_chars, counts}: media_met =
-- a requires group that lists a media kind is met BY media (with ai=false that pays on format; a task satisfied by
-- text/link alone is held instead, C16 -- a photo attached to a text-only task does not change that).
declare
  _media_kinds constant text[] := array['photo', 'image_doc', 'video', 'video_doc', 'document', 'voice', 'video_note', 'audio'];
  _counts jsonb := '{}'::jsonb;
  _text_chars int := 0;
  _it jsonb;
  _k text;
  _dur int;
  _missing text[] := '{}';
  _g jsonb;
  _n int;
  _media boolean := false;
  _media_met boolean := false;
  _mn int;
  _visible boolean := false;
  _mt int := greatest(coalesce(_min_text, 20), 1);
begin
  for _it in select value from jsonb_array_elements(case when jsonb_typeof(_items) = 'array' then _items else '[]'::jsonb end) loop
    _text_chars := _text_chars + coalesce(case when (_it->>'text_len') ~ '^[0-9]{1,7}$' then (_it->>'text_len')::int end, 0);
    _dur := case when (_it->>'duration') ~ '^[0-9]{1,7}$' then (_it->>'duration')::int end;
    for _k in select jsonb_array_elements_text(case when jsonb_typeof(_it->'kinds') = 'array' then _it->'kinds' else '[]'::jsonb end) loop
      continue when _k = 'text';
      continue when _k in ('voice', 'video_note', 'audio') and coalesce(_dur, 0) < coalesce(_min_dur, 0);
      _counts := jsonb_set(_counts, array[_k], to_jsonb(coalesce((_counts->>_k)::int, 0) + 1));
      if _k = any(_media_kinds) then
        _media := true;
      end if;
      if _k in ('photo', 'image_doc')
         or (_k in ('video', 'video_doc', 'document') and coalesce((_it->>'has_thumb')::boolean, false)) then
        _visible := true;
      end if;
    end loop;
  end loop;
  if _text_chars >= _mt then
    _visible := true;
  end if;

  if jsonb_typeof(_requires) is distinct from 'array' or jsonb_array_length(_requires) = 0 then
    if not ((_text_chars >= _mt and 'text' = any(coalesce(_accepts, '{}')))
            or exists (select 1 from jsonb_object_keys(_counts) k
                        where public.challenge_task_accepts_kind(k) = any(coalesce(_accepts, '{}')))) then
      _missing := array['text'];
    end if;
    _media_met := exists (select 1 from jsonb_object_keys(_counts) k
                           where k = any(_media_kinds) and public.challenge_task_accepts_kind(k) = any(coalesce(_accepts, '{}')));
  else
    for _g in select value from jsonb_array_elements(_requires) loop
      select coalesce(sum((_counts->>k)::int), 0)::int into _n
        from jsonb_array_elements_text(_g->'any') k where k <> 'text';
      select coalesce(sum((_counts->>k)::int), 0)::int into _mn
        from jsonb_array_elements_text(_g->'any') k where k = any(_media_kinds);
      if (_g->'any') ? 'text' and _text_chars >= _mt then
        _n := _n + 1;
      end if;
      if _n < coalesce((_g->>'min')::int, 1) then
        if not ((_g->>'label') = any(_missing)) then
          _missing := _missing || (_g->>'label');
        end if;
      elsif _mn > 0 then
        _media_met := true;
      end if;
    end loop;
  end if;
  return jsonb_build_object('complete', cardinality(_missing) = 0, 'missing', to_jsonb(_missing), 'media', _media,
                            'media_met', _media_met, 'ai_visible', _visible, 'text_chars', _text_chars, 'counts', _counts);
end
$fn$;

create or replace function public.challenge_task_can_create(_requires jsonb, _accepts text[], _kinds text[])
returns boolean
language sql
immutable
set search_path = public
as $fn$
  -- G3: a message may CREATE a submission only when it brings a non-text kind some requires group asks for, or the
  -- task's requires are text/link-only (or empty = any accepted item) and the message has one of those kinds.
  select case
    when jsonb_typeof(_requires) is distinct from 'array' or jsonb_array_length(_requires) = 0 then
      exists (select 1 from unnest(coalesce(_kinds, '{}')) k where public.challenge_task_accepts_kind(k) = any(coalesce(_accepts, '{}')))
    else
      exists (select 1 from jsonb_array_elements(_requires) g, jsonb_array_elements_text(g->'any') a
               where a <> 'text' and a = any(coalesce(_kinds, '{}')))
      or (not exists (select 1 from jsonb_array_elements(_requires) g, jsonb_array_elements_text(g->'any') a
                       where a not in ('text', 'link', 'ig_link'))
          and exists (select 1 from jsonb_array_elements(_requires) g, jsonb_array_elements_text(g->'any') a
                       where a = any(coalesce(_kinds, '{}'))))
  end
$fn$;

create or replace function public.challenge_task_supplies(_requires jsonb, _missing text[], _kinds text[])
returns boolean
language sql
immutable
set search_path = public
as $fn$
  -- R5 FIX-UP: does a message with these kinds supply one of the missing labels? (instagram_handle never.)
  select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(_requires) = 'array' then _requires else '[]'::jsonb end) g,
                               jsonb_array_elements_text(g->'any') a
                  where (g->>'label') = any(coalesce(_missing, '{}')) and a = any(coalesce(_kinds, '{}')))
      or ('ig_link' = any(coalesce(_missing, '{}')) and 'ig_link' = any(coalesce(_kinds, '{}')))
      or ('screenshot' = any(coalesce(_missing, '{}')) and coalesce(_kinds, '{}') && array['photo', 'image_doc'])
$fn$;

create or replace function public.challenge_task_comment_reason(_item jsonb, _reply_kind text, _min_text integer, _min_voice integer)
returns text
language plpgsql
immutable
set search_path = public
as $fn$
-- C18 + §6.4 step 6: NULL = goes on to attribution, else the comment sub-code. A 'comment' is silent and earns 0.
--   reply_classmate  TEXT-ONLY (non-Instagram links allowed) and replying to a non-staff classmate or to a bot
--                    message tied to ANOTHER student. A reply carrying media, or replying to staff / an anonymous
--                    admin / another bot message, is NOT a comment.
--   question         a question-like text.
--   short_text       text-only, no link, shorter than min_text_chars.
--   short_voice      a voice / video note shorter than min_voice_sec.
declare
  _kinds text[] := array(select jsonb_array_elements_text(case when jsonb_typeof(_item->'kinds') = 'array' then _item->'kinds' else '[]'::jsonb end));
  _media boolean;
begin
  _media := _kinds && array['photo', 'image_doc', 'video', 'video_doc', 'document', 'voice', 'video_note', 'audio'];
  if not _media and not ('ig_link' = any(_kinds)) and not coalesce((_item->>'ig_share')::boolean, false)
     and _reply_kind in ('classmate', 'classmate_bot_msg') then
    return 'reply_classmate';
  end if;
  if coalesce((_item->>'question')::boolean, false) then
    return 'question';
  end if;
  if not _media and not ('link' = any(_kinds))
     and coalesce((_item->>'text_len')::int, 0) < greatest(coalesce(_min_text, 20), 1) then
    return 'short_text';
  end if;
  if _kinds && array['voice', 'video_note'] and _kinds <@ array['voice', 'video_note', 'text']
     and coalesce((_item->>'duration')::int, 0) < greatest(coalesce(_min_voice, 3), 1) then
    return 'short_voice';
  end if;
  return null;
end
$fn$;

create or replace function public.challenge_task_edit_distance(_a text, _b text)
returns integer
language plpgsql
immutable
set search_path = public
as $fn$
-- Levenshtein on lower-cased input (fuzzystrmatch is not installed, F13). Inputs over 64 chars answer max(len).
declare
  _s text := lower(coalesce(_a, ''));
  _t text := lower(coalesce(_b, ''));
  _m int;
  _n int;
  _prev int[];
  _cur int[];
  _cost int;
begin
  _m := char_length(_s);
  _n := char_length(_t);
  if _m > 64 or _n > 64 then return greatest(_m, _n); end if;
  if _m = 0 then return _n; end if;
  if _n = 0 then return _m; end if;
  _prev := array(select generate_series(0, _n));
  for i in 1 .. _m loop
    _cur := array[i];
    for j in 1 .. _n loop
      _cost := case when substr(_s, i, 1) = substr(_t, j, 1) then 0 else 1 end;
      _cur := _cur || least(_cur[j] + 1, _prev[j + 1] + 1, _prev[j] + _cost);
    end loop;
    _prev := _cur;
  end loop;
  return _prev[_n + 1];
end
$fn$;

create or replace function public.challenge_task_dhash_distance(_a text, _b text)
returns integer
language plpgsql
immutable
set search_path = public
as $fn$
-- Hamming distance of two 64-bit dHashes (16 hex chars). NULL for anything else.
begin
  if coalesce(_a, '') !~ '^[0-9a-fA-F]{16}$' or coalesce(_b, '') !~ '^[0-9a-fA-F]{16}$' then
    return null;
  end if;
  return bit_count(('x' || _a)::bit(64) # ('x' || _b)::bit(64))::int;
exception when others then
  return null;
end
$fn$;

create or replace function public.challenge_task_norm_handle(_h text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select nullif(lower(btrim(regexp_replace(coalesce(_h, ''), '^[[:space:]]*@', ''), E' \t\r\n')), '')
$fn$;

create or replace function public.challenge_task_verdict_valid(_kind text, _v jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $fn$
-- The AI returns LABELS only (I3); this strict schema is the contract with challenge-task-check (PR-6).
--   general:   {reason, placeholder, inappropriate, secret, manipulation, on_task: yes|no|cannot_tell, confidence}
--   instagram: {reason, is_instagram_screenshot, handle_seen: string|null, tag_seen, post_age_text: string|null,
--               posted_recently: yes|no|cannot_tell, inappropriate, manipulation, confidence}
-- Exactly those keys; booleans are JSON booleans; confidence a number in [0, 1]; reason <= 500 chars.
declare
  _keys text[];
  _want text[];
  _k text;
begin
  if _v is null or jsonb_typeof(_v) <> 'object' then return false; end if;
  select coalesce(array_agg(k order by k), '{}') into _keys from jsonb_object_keys(_v) k;
  if _kind = 'general' then
    _want := array['confidence', 'inappropriate', 'manipulation', 'on_task', 'placeholder', 'reason', 'secret'];
    if _keys <> _want then return false; end if;
    foreach _k in array array['placeholder', 'inappropriate', 'secret', 'manipulation'] loop
      if jsonb_typeof(_v->_k) <> 'boolean' then return false; end if;
    end loop;
    if jsonb_typeof(_v->'on_task') <> 'string' or (_v->>'on_task') not in ('yes', 'no', 'cannot_tell') then return false; end if;
  elsif _kind = 'instagram' then
    _want := array['confidence', 'handle_seen', 'inappropriate', 'is_instagram_screenshot', 'manipulation', 'post_age_text',
                   'posted_recently', 'reason', 'tag_seen'];
    if _keys <> _want then return false; end if;
    foreach _k in array array['is_instagram_screenshot', 'tag_seen', 'inappropriate', 'manipulation'] loop
      if jsonb_typeof(_v->_k) <> 'boolean' then return false; end if;
    end loop;
    if jsonb_typeof(_v->'handle_seen') not in ('string', 'null') or jsonb_typeof(_v->'post_age_text') not in ('string', 'null') then
      return false;
    end if;
    if jsonb_typeof(_v->'posted_recently') <> 'string' or (_v->>'posted_recently') not in ('yes', 'no', 'cannot_tell') then
      return false;
    end if;
  else
    return false;
  end if;
  if jsonb_typeof(_v->'reason') <> 'string' or char_length(_v->>'reason') > 500 then return false; end if;
  if jsonb_typeof(_v->'confidence') <> 'number' or (_v->>'confidence')::numeric < 0 or (_v->>'confidence')::numeric > 1 then
    return false;
  end if;
  return true;
exception when others then
  return false;
end
$fn$;

-- ═══════════════════════════════ 3. Config parser (§4) and context helpers ═══════════════════════════════
create or replace function public.challenge_tasks_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- ONE parser for every daily-task function. Every field is parsed on its own: an ABSENT key takes its default
-- silently; a PRESENT but malformed key takes its default AND is listed in invalid[] (the watchdog alarms on it).
-- points.* / streak.* <= 0 switch that signal OFF (nothing ever inserts a 0 amount). miniapp_link is NULL (and
-- invalid) unless miniapp_onboarding = true (G28). active = challenge_tasks.enabled AND challenge.enabled AND a
-- parseable window (C20): anything else is a pause.
declare
  _c jsonb;
  _ch jsonb;
  _inv text[] := '{}';
  _o jsonb := '{}'::jsonb;
  _k text;
  _v jsonb;
  _i int;
  _n numeric;
  _t text;
  _arr jsonb;
  _ids text[];
  _days int[];
  _ws timestamptz;
  _we timestamptz;
  _win_bad boolean := false;
  _bools constant jsonb := '{"enabled":false,"post":true,"dm":true,"remind":true,"summary":true,"ai":false,"receipts":true,
                              "auto_register":true,"miniapp":false,"miniapp_onboarding":false}';
  _ints constant jsonb := '{"late_days":[2,0,7],"merge_window_min":[5,1,60],"min_text_chars":[20,1,2000],"min_voice_sec":[3,1,600],
                             "max_items_per_day":[40,1,1000],"max_attempts_per_task":[3,1,20],"max_moves_per_submission":[5,1,50],
                             "receipt_budget_per_chat_min":[12,1,60],"backfill_receipt_max_age_min":[120,0,10080],
                             "fail_open_after_min":[60,5,1440],"ai_max_checks_per_user_day":[6,1,100]}';
  _times constant jsonb := '{"post_time":"09:00","remind_time":"19:00","summary_time":"20:00","quiet_start":"22:00",
                              "quiet_end":"08:00","liveness_check_time":"14:00"}';
  _ig jsonb;
  _igo jsonb;
  _gen jsonb;
  _pts jsonb;
  _str jsonb;
begin
  _c := (select ps.value from public.platform_settings ps where ps.key = 'challenge_tasks');
  if _c is null then
    _c := '{}'::jsonb;
    _inv := _inv || 'row_missing'::text;
  elsif jsonb_typeof(_c) <> 'object' then
    _c := '{}'::jsonb;
    _inv := _inv || 'root'::text;
  end if;

  for _k, _v in select key, value from jsonb_each(_bools) loop
    if not (_c ? _k) or jsonb_typeof(_c->_k) = 'null' then
      _o := _o || jsonb_build_object(_k, _v);
    elsif jsonb_typeof(_c->_k) = 'boolean' then
      _o := _o || jsonb_build_object(_k, _c->_k);
    else
      _o := _o || jsonb_build_object(_k, _v);
      _inv := _inv || _k;
    end if;
  end loop;

  for _k, _v in select key, value from jsonb_each(_ints) loop
    _i := null;
    if _c ? _k and jsonb_typeof(_c->_k) <> 'null' then
      _i := public.challenge_cfg_int(_c->_k);
      if _i is null or _i < (_v->>1)::int or _i > (_v->>2)::int then
        _inv := _inv || _k;
        _i := null;
      end if;
    end if;
    _o := _o || jsonb_build_object(_k, coalesce(_i, (_v->>0)::int));
  end loop;

  for _k, _v in select key, value from jsonb_each(_times) loop
    _t := null;
    if _c ? _k and jsonb_typeof(_c->_k) <> 'null' then
      if jsonb_typeof(_c->_k) = 'string' and (_c->>_k) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        _t := _c->>_k;
      else
        _inv := _inv || _k;
      end if;
    end if;
    _o := _o || jsonb_build_object(_k, coalesce(_t, _v #>> '{}'));
  end loop;

  -- late_factor (0, 1]
  _n := null;
  if _c ? 'late_factor' and jsonb_typeof(_c->'late_factor') <> 'null' then
    _n := public.challenge_cfg_num(_c->'late_factor');
    if _n is null or _n <= 0 or _n > 1 then _inv := _inv || 'late_factor'::text; _n := null; end if;
  end if;
  _o := _o || jsonb_build_object('late_factor', coalesce(_n, 0.5));

  -- points: <= 0 switches the type OFF (0); malformed -> default + invalid
  _pts := case when jsonb_typeof(_c->'points') = 'object' then _c->'points' else '{}'::jsonb end;
  if _c ? 'points' and jsonb_typeof(_c->'points') not in ('object', 'null') then _inv := _inv || 'points'::text; end if;
  foreach _k in array array['general', 'instagram'] loop
    _i := null;
    if _pts ? _k and jsonb_typeof(_pts->_k) <> 'null' then
      _i := public.challenge_cfg_int(_pts->_k);
      if _i is null or _i > 50 then _inv := _inv || ('points.' || _k); _i := null;
      elsif _i < 0 then _i := 0; end if;
    end if;
    _o := jsonb_set(_o, '{points}', coalesce(_o->'points', '{}'::jsonb) || jsonb_build_object(_k, coalesce(_i, case _k when 'general' then 5 else 8 end)));
  end loop;

  -- streak: every / bonus <= 0 switches the streak OFF
  _str := case when jsonb_typeof(_c->'streak') = 'object' then _c->'streak' else '{}'::jsonb end;
  foreach _k in array array['every', 'bonus'] loop
    _i := null;
    if _str ? _k and jsonb_typeof(_str->_k) <> 'null' then
      _i := public.challenge_cfg_int(_str->_k);
      if _i is null or _i > 100 then _inv := _inv || ('streak.' || _k); _i := null;
      elsif _i < 0 then _i := 0; end if;
    end if;
    _o := jsonb_set(_o, '{streak}', coalesce(_o->'streak', '{}'::jsonb) || jsonb_build_object(_k, coalesce(_i, case _k when 'every' then 5 else 10 end)));
  end loop;

  -- task_weekdays: ISO weekdays 1..7 (an empty list = only calendar dates are task days)
  _days := array[1, 2, 3, 4, 5];
  if _c ? 'task_weekdays' and jsonb_typeof(_c->'task_weekdays') <> 'null' then
    begin
      if jsonb_typeof(_c->'task_weekdays') <> 'array' then raise exception 'bad'; end if;
      select coalesce(array_agg(distinct (x #>> '{}')::int order by (x #>> '{}')::int), '{}') into _days
        from jsonb_array_elements(_c->'task_weekdays') x;
      if exists (select 1 from jsonb_array_elements(_c->'task_weekdays') x
                  where jsonb_typeof(x) <> 'number' or (x #>> '{}') !~ '^[1-7]$') then
        raise exception 'bad';
      end if;
    exception when others then
      _days := array[1, 2, 3, 4, 5];
      _inv := _inv || 'task_weekdays'::text;
    end;
  end if;
  _o := _o || jsonb_build_object('task_weekdays', to_jsonb(_days));

  -- test_group_ids: uuids (E2E only, G26); a bad element is dropped and flagged
  _ids := '{}';
  if _c ? 'test_group_ids' and jsonb_typeof(_c->'test_group_ids') <> 'null' then
    if jsonb_typeof(_c->'test_group_ids') <> 'array' then
      _inv := _inv || 'test_group_ids'::text;
    else
      select coalesce(array_agg(x), '{}') into _ids from jsonb_array_elements_text(_c->'test_group_ids') x
       where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      if cardinality(_ids) <> jsonb_array_length(_c->'test_group_ids') then _inv := _inv || 'test_group_ids'::text; end if;
    end if;
  end if;
  _o := _o || jsonb_build_object('test_group_ids', to_jsonb(_ids));

  -- miniapp_link: refused until tg-miniapp-auth can onboard members (C10, G28)
  if jsonb_typeof(_c->'miniapp_link') = 'string' and btrim(_c->>'miniapp_link') <> '' then
    if coalesce((_o->>'miniapp_onboarding')::boolean, false) and (_c->>'miniapp_link') ~ '^https://t\.me/[A-Za-z0-9_]{3,64}(/[A-Za-z0-9_]{1,64})?(\?startapp=[A-Za-z0-9_-]{0,64})?$' then
      _o := _o || jsonb_build_object('miniapp_link', _c->>'miniapp_link');
    else
      _o := _o || jsonb_build_object('miniapp_link', null);
      _inv := _inv || 'miniapp_link'::text;
    end if;
  else
    if _c ? 'miniapp_link' and jsonb_typeof(_c->'miniapp_link') not in ('null', 'string') then _inv := _inv || 'miniapp_link'::text; end if;
    _o := _o || jsonb_build_object('miniapp_link', null);
  end if;

  -- ig.*
  _ig := case when jsonb_typeof(_c->'ig') = 'object' then _c->'ig' else '{}'::jsonb end;
  if _c ? 'ig' and jsonb_typeof(_c->'ig') not in ('object', 'null') then _inv := _inv || 'ig'::text; end if;
  _t := null;
  if _ig ? 'tag_handle' and jsonb_typeof(_ig->'tag_handle') <> 'null' then
    if jsonb_typeof(_ig->'tag_handle') = 'string' and public.challenge_task_norm_handle(_ig->>'tag_handle') ~ '^[a-z0-9._]{1,30}$' then
      _t := public.challenge_task_norm_handle(_ig->>'tag_handle');
    else
      _inv := _inv || 'ig.tag_handle'::text;
    end if;
  end if;
  _igo := jsonb_build_object('tag_handle', coalesce(_t, 'aicreators.students'));
  foreach _k in array array['require_recent', 'existence_probe', 'lock_handle_after_accept'] loop
    if _ig ? _k and jsonb_typeof(_ig->_k) <> 'null' and jsonb_typeof(_ig->_k) <> 'boolean' then
      _inv := _inv || ('ig.' || _k);
    end if;
    _igo := _igo || jsonb_build_object(_k, case when jsonb_typeof(_ig->_k) = 'boolean' then _ig->_k else 'true'::jsonb end);
  end loop;
  foreach _k in array array['min_confidence', 'recent_min_confidence'] loop
    _n := null;
    if _ig ? _k and jsonb_typeof(_ig->_k) <> 'null' then
      _n := public.challenge_cfg_num(_ig->_k);
      if _n is null or _n < 0 or _n > 1 then _inv := _inv || ('ig.' || _k); _n := null; end if;
    end if;
    _igo := _igo || jsonb_build_object(_k, coalesce(_n, case _k when 'min_confidence' then 0.6 else 0.8 end));
  end loop;
  foreach _k in array array['handle_edit_distance', 'dhash_max_distance'] loop
    _i := null;
    if _ig ? _k and jsonb_typeof(_ig->_k) <> 'null' then
      _i := public.challenge_cfg_int(_ig->_k);
      if _i is null or _i < 0 or _i > (case _k when 'handle_edit_distance' then 3 else 20 end) then
        _inv := _inv || ('ig.' || _k); _i := null;
      end if;
    end if;
    _igo := _igo || jsonb_build_object(_k, coalesce(_i, case _k when 'handle_edit_distance' then 1 else 4 end));
  end loop;
  _o := _o || jsonb_build_object('ig', _igo);

  _gen := case when jsonb_typeof(_c->'generic') = 'object' then _c->'generic' else '{}'::jsonb end;
  _n := public.challenge_cfg_num(_gen->'offtask_min_confidence');
  if _gen ? 'offtask_min_confidence' and (_n is null or _n < 0 or _n > 1) then _inv := _inv || 'generic.offtask_min_confidence'::text; _n := null; end if;
  _o := _o || jsonb_build_object('generic', jsonb_build_object('offtask_min_confidence', coalesce(_n, 0.85)));

  _n := public.challenge_cfg_num(_c->'ai_daily_budget_usd');
  if _c ? 'ai_daily_budget_usd' and (_n is null or _n < 0) then _inv := _inv || 'ai_daily_budget_usd'::text; _n := null; end if;
  _o := _o || jsonb_build_object('ai_daily_budget_usd', coalesce(_n, 3));
  _o := _o || jsonb_build_object(
    'ai_provider_order', case when jsonb_typeof(_c->'ai_provider_order') = 'array' then _c->'ai_provider_order' else '["anthropic","openai"]'::jsonb end,
    'ai_models', case when jsonb_typeof(_c->'ai_models') = 'object' then _c->'ai_models' else '{"anthropic":"claude-haiku-4-5","openai":"gpt-5-mini"}'::jsonb end,
    'ai_prices', case when jsonb_typeof(_c->'ai_prices') = 'object' then _c->'ai_prices' else '{"anthropic":[1,5],"openai":[0.25,2]}'::jsonb end);

  -- the challenge row: enabled + the window DATES (C20). A malformed window fails closed (a pause), loudly.
  _ch := coalesce(public.challenge_config(), '{}'::jsonb);
  if jsonb_typeof(_ch) <> 'object' then _ch := '{}'::jsonb; end if;
  begin
    _ws := nullif(_ch->'window'->>'start', '')::timestamptz;
  exception when others then _ws := null; _win_bad := true;
  end;
  begin
    _we := nullif(_ch->'window'->>'end', '')::timestamptz;
  exception when others then _we := null; _win_bad := true;
  end;
  if _win_bad then _inv := _inv || 'challenge.window'::text; end if;
  _o := _o || jsonb_build_object(
    'challenge_enabled', coalesce(case when jsonb_typeof(_ch->'enabled') = 'boolean' then (_ch->>'enabled')::boolean end, false),
    'w_start', _ws, 'w_end', _we,
    'w_start_date', (_ws at time zone 'Asia/Tashkent')::date,
    'w_end_date', (_we at time zone 'Asia/Tashkent')::date,
    'win_bad', _win_bad);
  _o := _o || jsonb_build_object('active', (_o->>'enabled')::boolean and (_o->>'challenge_enabled')::boolean and not _win_bad);
  return _o || jsonb_build_object('invalid', to_jsonb(_inv));
exception when others then
  -- Anything unforeseen: a PAUSE (no capture, no award), loudly.
  return jsonb_build_object('enabled', false, 'challenge_enabled', false, 'active', false, 'ai', false, 'receipts', false,
                            'miniapp', false, 'win_bad', true, 'invalid', jsonb_build_array('config_parse_error'));
end
$fn$;

create or replace function public.challenge_tasks_note_invalid(_cfg jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- At most one 'challenge_task_config_invalid' row per key set per Tashkent day (§4).
begin
  if coalesce(jsonb_array_length(_cfg->'invalid'), 0) = 0 then return; end if;
  if exists (select 1 from public.admin_actions a
              where a.action = 'challenge_task_config_invalid'
                and a.created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent')
                and a.details->'keys' = _cfg->'invalid') then
    return;
  end if;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_task_config_invalid', jsonb_build_object('keys', _cfg->'invalid', 'at', now()));
exception when others then
  null;
end
$fn$;

create or replace function public.challenge_task_local_date(_ts timestamptz)
returns date
language sql
immutable
set search_path = public
as $fn$
  select (_ts at time zone 'Asia/Tashkent')::date
$fn$;

create or replace function public.challenge_task_open_at(_t public.challenge_tasks, _group uuid, _cfg jsonb)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  -- open_at(T) = task_date at post_time, Tashkent (a 'retro' task: 00:00). A post the bot or staff actually made
  -- EARLIER that day in this group opens it then (a manual post at 08:30 is answerable at 08:30).
  select least(
           case when _t.source = 'retro' then (_t.task_date::timestamp at time zone 'Asia/Tashkent')
                else ((_t.task_date + coalesce((_cfg->>'post_time')::time, time '09:00'))::timestamp at time zone 'Asia/Tashkent') end,
           (select min(p.sent_at) from public.challenge_task_posts p
             where p.task_id = _t.id and p.group_id = _group and p.kind = 'task'
               and p.state in ('sent', 'sent_via_sql', 'manual')
               and p.sent_at >= (_t.task_date::timestamp at time zone 'Asia/Tashkent')))
$fn$;

create or replace function public.challenge_task_close_at(_t public.challenge_tasks, _cfg jsonb)
returns timestamptz
language sql
immutable
set search_path = public
as $fn$
  -- close_at(T) = the start of task_date + late_days + 1 (Tashkent). On time = by 23:59 of task_date.
  select ((_t.task_date + coalesce((_cfg->>'late_days')::int, 2) + 1)::timestamp at time zone 'Asia/Tashkent')
$fn$;

create or replace function public.challenge_task_void_at(_user uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  -- The newest void tombstone (#218's admin_void_challenge_points). Work first posted at or before it never pays.
  select max(a.created_at) from public.admin_actions a
   where a.action = 'challenge_points_voided' and a.target_user_id = _user
$fn$;

create or replace function public.challenge_task_week_frozen_at(_ts timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  -- R4: when the Tashkent week (Mon..Sun) containing _ts was frozen by freeze_challenge_week, else NULL. The freeze
  -- keys a week TWO ways (verified live): a manual run stores the Monday; the weekly cron stores `_prev_mon::date` in
  -- the server's UTC session = the SUNDAY before. Both are read: a Sunday key can only mean the week that starts the
  -- next day (a manual key is always a Monday). Sources: challenge_weekly_results.week_start and the
  -- 'challenge_week_frozen' audit row (written even when nobody scored).
  with k as (select date_trunc('week', _ts at time zone 'Asia/Tashkent')::date as mon)
  select least(
    (select min(r.created_at) from public.challenge_weekly_results r, k where r.week_start in (k.mon, k.mon - 1)),
    (select min(a.created_at) from public.admin_actions a, k
      where a.action = 'challenge_week_frozen'
        and a.details->>'week' in (to_char(k.mon, 'YYYY-MM-DD'), to_char(k.mon - 1, 'YYYY-MM-DD'))))
$fn$;

create or replace function public.challenge_task_award_ts(_ts timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  -- C11 / G11: an award normally takes created_at = submitted_at. If the Tashkent week containing it was already
  -- frozen (challenge_task_week_frozen_at, R4), created_at = now(): the points land on the CURRENT week's board
  -- instead of vanishing from prizes.
  select case when public.challenge_task_week_frozen_at(_ts) is not null then now() else _ts end
$fn$;

create or replace function public.challenge_task_is_task_day(_course uuid, _d date, _cfg jsonb)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  -- C22 / G6: a date carrying an approved task (for _course, or any course when NULL), or a configured weekday ON OR
  -- AFTER the first approved task date (d4: the calendar starts at its first task -- Monday 2026-10-05 by the owner's
  -- decision -- so the weekdays before it never alarm), always inside the challenge window dates.
  select (exists (select 1 from public.challenge_tasks t
                   where t.task_date = _d and t.status = 'approved' and (_course is null or t.course_id = _course))
          or (extract(isodow from _d)::int in (select (x #>> '{}')::int
                                                 from jsonb_array_elements(coalesce(_cfg->'task_weekdays', '[1,2,3,4,5]'::jsonb)) x)
              and _d >= coalesce((select min(t.task_date) from public.challenge_tasks t
                                   where t.status = 'approved' and (_course is null or t.course_id = _course)), 'infinity'::date)))
     and (_cfg->>'w_start_date' is null or _d >= (_cfg->>'w_start_date')::date)
     and (_cfg->>'w_end_date' is null or _d <= (_cfg->>'w_end_date')::date)
$fn$;

create or replace function public.challenge_task_dm_eligible(_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  -- C15: a private chat with the bot is on record, or the Mini App granted write access.
  select exists (select 1 from public.profiles p
                  where p.id = _user
                    and (p.telegram_write_access_at is not null
                         or (p.telegram_id is not null
                             and exists (select 1 from public.webhook_inbox w
                                          where w.chat_id = p.telegram_id and w.from_user_id = p.telegram_id))))
$fn$;

create or replace function public.challenge_task_day_no(_t public.challenge_tasks)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select 1 + (select count(*)::int from public.challenge_tasks x
               where x.course_id = _t.course_id and x.status = 'approved' and x.task_date < _t.task_date)
$fn$;

create or replace function public.challenge_task_points_for(_t public.challenge_tasks, _late_days integer, _cfg jsonb)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  -- §8.1: base = the task's override, else config points[type] (0 = that type is OFF); late 1..late_days =
  -- ceil(base * late_factor); later = 0.
  with b as (
    select coalesce(_t.points, (_cfg->'points'->>coalesce(_t.type, 'general'))::int, case when _t.type = 'instagram' then 8 else 5 end) as base
  )
  select case
    when b.base <= 0 or _late_days is null or _late_days < 0 then 0
    when _late_days = 0 then b.base
    when _late_days <= coalesce((_cfg->>'late_days')::int, 2) then greatest(1, ceil(b.base * coalesce((_cfg->>'late_factor')::numeric, 0.5)))::int
    else 0 end
  from b
$fn$;

create or replace function public.challenge_task_rejected_count(_user uuid, _task_id bigint)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  -- The attempts used against max_attempts_per_task: rejected submissions, INCLUDING a rejected one that was later
  -- withdrawn (R3: withdrawing never gives an attempt back). The ONE count every attempts rule reads.
  select count(*)::int from public.challenge_task_submissions x
   where x.user_id = _user and x.task_id = _task_id
     and (x.status = 'rejected' or (x.status = 'withdrawn' and x.withdrawn_from = 'rejected'))
$fn$;

-- ═══════════════════════════════ 4. Evaluate, settle (the ONLY writer of task points), streak, legacy swap ═══════════════════════════════
create or replace function public.challenge_task_rebuild_user_xp(_user uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $fn$
  -- Rebuilds ONE student's user_xp (G31). Callers hold pg_advisory_xact_lock(hashtext('user_xp:' || user)).
  insert into public.user_xp (user_id, total_xp, level, updated_at)
  select _user, coalesce(sum(e.amount), 0)::int, public.xp_level_for(coalesce(sum(e.amount), 0)::int), now()
    from public.xp_events e where e.user_id = _user
  on conflict (user_id) do update set total_xp = excluded.total_xp, level = excluded.level, updated_at = now()
$fn$;

create or replace function public.challenge_task_evaluate(_sub bigint, _cfg jsonb, _bump boolean default true)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.7, deterministic. Only a needs_more / checking submission is (re)judged: appending to an accepted one changes
-- nothing, and terminal statuses stay. _bump = items changed: a submission already 'checking' gets a new
-- check_version (an in-flight AI check becomes stale). Any visible change bumps receipt_version.
declare
  _s public.challenge_task_submissions;
  _t public.challenge_tasks;
  _items jsonb;
  _ev jsonb;
  _missing text[];
  _status text;
  _reason text;
  _hold text;
  _handle text;
  _sc text;
  _any_sc boolean;
  _share boolean;
  _reuse_other boolean;
  _reuse_own boolean := false;
  _ai boolean := coalesce((_cfg->>'ai')::boolean, false);
  _changed boolean;
  _rechk boolean;
begin
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  if not found then return null; end if;
  if _s.status not in ('needs_more', 'checking') then return _s.status; end if;
  select * into _t from public.challenge_tasks where id = _s.task_id;

  select coalesce(jsonb_agg(m.item order by m.sent_at, m.message_id), '[]'::jsonb) into _items
    from public.challenge_task_messages m
   where m.submission_id = _sub and m.outcome in ('created', 'appended', 'appended_album', 'adopted');
  _ev := public.challenge_task_requires_eval(_t.type, _t.requires, _t.accepts, _items,
           coalesce(_t.min_text_chars, (_cfg->>'min_text_chars')::int), coalesce(_t.min_duration_sec, (_cfg->>'min_voice_sec')::int));
  _missing := array(select jsonb_array_elements_text(_ev->'missing'));

  -- C13: exact reuse of a file ANOTHER student posted earlier rejects, in every task.
  _reuse_other := exists (
    select 1
      from public.challenge_task_messages m
      join public.challenge_task_messages o on o.file_ids && m.file_ids
     where m.submission_id = _sub and m.outcome in ('created', 'appended', 'appended_album', 'adopted')
       and cardinality(m.file_ids) > 0
       and o.user_id is not null and o.user_id <> _s.user_id
       and o.outcome not in ('staff', 'anonymous', 'bot')
       and (o.sent_at < m.sent_at or (o.sent_at = m.sent_at and o.id < m.id)));

  if _t.type = 'instagram' then
    -- The student's OWN image from another task's submission (instagram only).
    _reuse_own := exists (
      select 1
        from public.challenge_task_messages m
        join public.challenge_task_messages o on o.file_ids && m.file_ids
        join public.challenge_task_submissions os on os.id = o.submission_id
       where m.submission_id = _sub and m.outcome in ('created', 'appended', 'appended_album', 'adopted')
         and cardinality(m.file_ids) > 0
         and o.user_id = _s.user_id and os.task_id <> _s.task_id
         and o.outcome in ('created', 'appended', 'appended_album', 'adopted'));
    select p.instagram_username::text into _handle from public.profiles p where p.id = _s.user_id;
    -- the newest shortcode not already paid to another submission
    select x.sc into _sc
      from (select m.item->>'shortcode' as sc, m.sent_at, m.message_id
              from public.challenge_task_messages m
             where m.submission_id = _sub and m.outcome in ('created', 'appended', 'appended_album', 'adopted')
               and m.item->>'shortcode' is not null) x
     where not exists (select 1 from public.challenge_ig_posts g where g.shortcode = x.sc and g.submission_id is distinct from _sub)
     order by x.sent_at desc, x.message_id desc
     limit 1;
    _any_sc := exists (select 1 from jsonb_array_elements(_items) i where i->>'shortcode' is not null);
    _share := exists (select 1 from jsonb_array_elements(_items) i where coalesce((i->>'ig_share')::boolean, false));
    if _sc is null and not ('ig_link' = any(_missing)) then
      _missing := _missing || 'ig_link'::text;
    end if;
    if _handle is null then
      _missing := _missing || 'instagram_handle'::text;
    end if;
    if _sc is null and _any_sc then
      _reason := 'ig_link_reused';
    elsif _sc is null and _share then
      _reason := 'ig_link_share';
    end if;
    if _reuse_other then
      _status := 'rejected'; _reason := 'image_seen_before'; _missing := '{}';
    elsif _reuse_own then
      _status := 'rejected'; _reason := 'image_reused'; _missing := '{}';
    elsif cardinality(_missing) > 0 then
      _status := 'needs_more';
    else
      _status := 'checking';
      _hold := case when _ai then null else 'ig_waiting_ai' end;   -- instagram is never paid unchecked (G3, C16)
    end if;
  else
    if _reuse_other then
      _status := 'rejected'; _reason := 'image_seen_before'; _missing := '{}';
    elsif cardinality(_missing) > 0 then
      _status := 'needs_more';
    elsif _ai then
      _status := case when coalesce((_ev->>'ai_visible')::boolean, false) then 'checking' else 'accepted' end;
    elsif coalesce((_ev->>'media_met')::boolean, false) then
      _status := 'accepted';                    -- ai=false: a met MEDIA group pays on format
    else
      _status := 'checking'; _hold := 'ai_off';  -- ai=false and satisfied by text/link only: HELD, never paid unchecked
    end if;
  end if;

  _rechk := _status = 'checking' and (_s.status <> 'checking' or _bump);
  _changed := _status is distinct from _s.status or _missing is distinct from _s.missing or _reason is distinct from _s.reason
              or _hold is distinct from _s.hold_reason or _rechk;
  update public.challenge_task_submissions set
    status = _status,
    missing = _missing,
    reason = _reason,
    hold_reason = _hold,
    ig_shortcode = case when _t.type = 'instagram' then _sc else ig_shortcode end,
    ig_handle_snapshot = case when _t.type = 'instagram' and _status = 'checking'
                              then case when _s.status <> 'checking' or ig_handle_snapshot is null then _handle::citext
                                        else ig_handle_snapshot end
                              else ig_handle_snapshot end,
    check_version = check_version + case when _rechk then 1 else 0 end,
    check_token = case when _rechk then null else check_token end,
    check_claimed_at = case when _rechk then null else check_claimed_at end,
    checking_since = case when _rechk then now() else checking_since end,
    accepted_at = case when _status = 'accepted' and _s.status <> 'accepted' then now() else accepted_at end,
    receipt_version = receipt_version + case when _changed then 1 else 0 end,
    updated_at = now()
  where id = _sub;
  return _status;
end
$fn$;

create or replace function public.challenge_task_streak_current(_user uuid, _course uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  -- The display streak: consecutive approved task dates (rest days skipped) with an ON-TIME accepted submission,
  -- ending at the student's latest on-time task. Late work never counts.
  with t as (
    select x.task_date,
           exists (select 1 from public.challenge_task_submissions s
                    where s.user_id = _user and s.task_id = x.id and s.status = 'accepted' and s.late_days = 0) as done
      from public.challenge_tasks x
     where x.course_id = _course and x.status = 'approved'
  ),
  last_done as (select max(task_date) as d from t where done),
  last_miss as (select max(t.task_date) as d from t, last_done where not t.done and t.task_date < last_done.d)
  select coalesce((select count(*)::int from t, last_done, last_miss
                    where t.done and t.task_date <= last_done.d and (last_miss.d is null or t.task_date > last_miss.d)), 0)
$fn$;

create or replace function public.challenge_task_streak_recompute(_user uuid, _course uuid, _cfg jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §8.3 + R2: walks the course's approved task dates in order. A run is a maximal sequence of task dates with an
-- ON-TIME accepted submission (rest days are not task dates, so they are skipped; a missed / late / held day ends
-- it). Every award is sticky (only a void removes it) and CLAIMS the `every` on-time days that paid it
-- (claimed_dates). Inside a run, days an earlier award already claimed are skipped; the run's UNCLAIMED on-time days
-- are counted and every `every` of them write ONE award (dated on the day that completed the count) plus its ledger
-- row 'ch_task_streak:<date>' (reason challenge_task_streak), freeze-aware like every award. So however a run is
-- split and re-joined (withdraw -> restore, a held check accepted later, a reassign), a day pays toward one award at
-- most and a run of L days is paid floor(L / every) times. Awards older than the student's newest void tombstone
-- claim nothing (their days were voided). Returns the length of the latest run.
declare
  _every int := coalesce((_cfg->'streak'->>'every')::int, 5);
  _bonus int := coalesce((_cfg->'streak'->>'bonus')::int, 10);
  _void timestamptz := public.challenge_task_void_at(_user);
  _claimed date[];
  _r record;
  _run int := 0;
  _last_run int := 0;
  _buf date[] := '{}';
  _buf_ts timestamptz;
  _ref text;
  _ins int;
  _any boolean := false;
begin
  if _user is null or _course is null or _every <= 0 or _bonus <= 0 then
    return 0;
  end if;
  select coalesce(array_agg(distinct d.d), '{}') into _claimed
    from public.challenge_task_streak_awards a, unnest(a.claimed_dates) d(d)
   where a.user_id = _user and a.course_id = _course and a.created_at > coalesce(_void, '-infinity'::timestamptz);
  for _r in
    select x.id, x.task_date,
           (select s.submitted_at from public.challenge_task_submissions s
             where s.user_id = _user and s.task_id = x.id and s.status = 'accepted' and s.late_days = 0
             limit 1) as on_time_at
      from public.challenge_tasks x
     where x.course_id = _course and x.status = 'approved'
       and x.task_date <= coalesce((select max(t2.task_date) from public.challenge_tasks t2
                                     join public.challenge_task_submissions s2 on s2.task_id = t2.id
                                    where t2.course_id = _course and s2.user_id = _user and s2.status = 'accepted'
                                      and s2.late_days = 0), date '1900-01-01')
     order by x.task_date
  loop
    if _r.on_time_at is null then
      _run := 0;                                -- the run ends: unclaimed days never carry over a gap
      _buf := '{}';
      _buf_ts := null;
      continue;
    end if;
    _run := _run + 1;
    _last_run := _run;
    if _r.task_date = any(_claimed) then
      continue;                                 -- this day already paid a (sticky) award
    end if;
    _buf := _buf || _r.task_date;
    _buf_ts := greatest(coalesce(_buf_ts, _r.on_time_at), _r.on_time_at);
    if cardinality(_buf) >= _every then
      _ref := 'ch_task_streak:' || _r.task_date::text;
      insert into public.challenge_task_streak_awards (user_id, course_id, task_date, streak_len, bonus, xp_ref_key, claimed_dates)
      values (_user, _course, _r.task_date, _run, _bonus, _ref, _buf)
      on conflict (user_id, course_id, task_date) do nothing;
      get diagnostics _ins = row_count;
      if _ins > 0 then
        perform pg_advisory_xact_lock(hashtext('ctask:' || _user::text));
        perform pg_advisory_xact_lock(hashtext('user_xp:' || _user::text));
        insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
        values (_user, _bonus, 'challenge_task_streak', _ref, public.challenge_task_award_ts(_buf_ts))
        on conflict (user_id, ref_key) do nothing;
        _any := true;
        _claimed := _claimed || _buf;
        insert into public.admin_actions (actor_user_id, action, target_user_id, details)
        values (null, 'challenge_task_streak_awarded', _user, jsonb_build_object(
          'course_id', _course, 'task_date', _r.task_date, 'streak_len', _run, 'bonus', _bonus,
          'claimed_dates', to_jsonb(_buf), 'at', now()));
      end if;
      _buf := '{}';
      _buf_ts := null;
    end if;
  end loop;
  if _any then
    perform public.challenge_task_rebuild_user_xp(_user);
  end if;
  return _last_run;
end
$fn$;

create or replace function public.challenge_task_settle_ut(_user uuid, _task_id bigint, _cfg jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §8.2: the ONLY writer of daily-task points. Keyed by (user, task): ref 'ch_task:<task_id>', reason challenge_task.
-- amount = 0 unless an ACCEPTED submission exists, the task is approved and the work was first posted after the
-- student's newest void tombstone; else base / ceil(base * late_factor). An unchanged amount keeps the row (and
-- its created_at); a new or changed row gets the freeze-aware created_at (C11). An instagram acceptance claims
-- its shortcode in challenge_ig_posts in the same transaction -- a shortcode another submission owns makes this
-- one 'rejected / ig_link_reused'. Takes the per-student user_xp lock and rebuilds only that student (G31).
declare
  _t public.challenge_tasks;
  _s public.challenge_task_submissions;
  _found boolean;
  _amount int := 0;
  _void timestamptz;
  _ref text := 'ch_task:' || _task_id::text;
  _e record;
  _ts timestamptz;
  _changed boolean := false;
  _owner record;
  _prev int;
begin
  if _user is null or _task_id is null then return 0; end if;
  -- lock order, everywhere: ctask:<student> (the engine's per-student lock) THEN user_xp:<student> (G31). Both are
  -- re-entrant inside one transaction, so a caller that already holds them pays nothing.
  perform pg_advisory_xact_lock(hashtext('ctask:' || _user::text));
  perform pg_advisory_xact_lock(hashtext('user_xp:' || _user::text));
  select * into _t from public.challenge_tasks where id = _task_id;
  select * into _s from public.challenge_task_submissions
   where user_id = _user and task_id = _task_id and status = 'accepted' for update;
  _found := found;
  if _found and _t.status = 'approved' then
    _void := public.challenge_task_void_at(_user);
    if _void is not null and _s.submitted_at <= _void then
      update public.challenge_task_submissions
         set status = 'voided', reason = 'points_voided', receipt_version = receipt_version + 1, updated_at = now()
       where id = _s.id;
      _found := false;
    else
      _amount := public.challenge_task_points_for(_t, _s.late_days, _cfg);
      if _amount > 0 and _t.type = 'instagram' then
        if _s.ig_shortcode is null then
          _amount := 0;
        else
          insert into public.challenge_ig_posts (shortcode, user_id, submission_id, task_id)
          values (_s.ig_shortcode, _user, _s.id, _task_id)
          on conflict (shortcode) do nothing;
          select g.submission_id, g.user_id into _owner from public.challenge_ig_posts g where g.shortcode = _s.ig_shortcode;
          if _owner.submission_id is null and _owner.user_id = _user then
            update public.challenge_ig_posts set submission_id = _s.id, task_id = _task_id where shortcode = _s.ig_shortcode;
          elsif _owner.submission_id is distinct from _s.id then
            update public.challenge_task_submissions
               set status = 'rejected', reason = 'ig_link_reused', receipt_version = receipt_version + 1, updated_at = now()
             where id = _s.id;
            _amount := 0;
            _found := false;
          end if;
        end if;
      end if;
    end if;
  else
    _found := false;
  end if;

  select x.id, x.amount, x.created_at into _e from public.xp_events x where x.user_id = _user and x.ref_key = _ref;
  _prev := coalesce(_e.amount, 0);
  if _amount <= 0 then
    if _e.id is not null then
      delete from public.xp_events where id = _e.id;
      _changed := true;
    end if;
  elsif _e.id is null then
    _ts := public.challenge_task_award_ts(_s.submitted_at);
    insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
    values (_user, _amount, 'challenge_task', _ref, _ts);
    update public.challenge_task_submissions set xp_created_at = _ts, awarded_at = now() where id = _s.id;
    _changed := true;
  elsif _e.amount <> _amount then
    _ts := public.challenge_task_award_ts(_s.submitted_at);
    update public.xp_events set amount = _amount, created_at = _ts where id = _e.id;
    update public.challenge_task_submissions set xp_created_at = _ts, awarded_at = now() where id = _s.id;
    _changed := true;
  else
    update public.challenge_task_submissions set xp_created_at = coalesce(xp_created_at, _e.created_at),
                                                 awarded_at = coalesce(awarded_at, now())
     where id = _s.id and xp_created_at is null;
  end if;

  update public.challenge_task_submissions x
     set points_awarded = case when _found and x.id = _s.id then greatest(_amount, 0) else 0 end
   where x.user_id = _user and x.task_id = _task_id
     and x.points_awarded is distinct from (case when _found and x.id = _s.id then greatest(_amount, 0) else 0 end);

  if _changed then
    perform public.challenge_task_rebuild_user_xp(_user);
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_points_changed', _user, jsonb_build_object(
      'task_id', _task_id, 'submission_id', case when _found then _s.id end, 'amount', greatest(_amount, 0),
      'previous', _prev, 'late_days', case when _found then _s.late_days end, 'created_at', _ts, 'at', now()));
  end if;
  perform public.challenge_task_streak_recompute(_user, _t.course_id, _cfg);
  return greatest(_amount, 0);
end
$fn$;

create or replace function public.challenge_task_legacy_swap(_user uuid, _chat bigint, _msg bigint, _mgid text)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.8: a message that became a task item never also pays the legacy media/chat points it may have earned before
-- PR-1 excluded the topic. Deletes ch_img:/ch_chat:<chat>:<msg> and ch_alb:<chat>:<media_group_id> for this
-- student, rebuilds their user_xp, writes 'challenge_task_legacy_swap'. Residuals (G23): comment rows keep theirs.
declare
  _gone jsonb;
  _n int;
begin
  if _user is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _user::text));
  perform pg_advisory_xact_lock(hashtext('user_xp:' || _user::text));
  with d as (
    delete from public.xp_events e
     where e.user_id = _user
       and e.ref_key in ('ch_img:' || _chat::text || ':' || _msg::text,
                         'ch_chat:' || _chat::text || ':' || _msg::text,
                         'ch_alb:' || _chat::text || ':' || coalesce(_mgid, '-'))
       and (e.ref_key not like 'ch_alb:%' or _mgid is not null)
    returning e.ref_key, e.amount, e.reason
  )
  select coalesce(jsonb_agg(jsonb_build_object('ref_key', d.ref_key, 'amount', d.amount, 'reason', d.reason)), '[]'::jsonb), count(*)
    into _gone, _n from d;
  if _n > 0 then
    perform public.challenge_task_rebuild_user_xp(_user);
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_legacy_swap', _user, jsonb_build_object(
      'chat_id', _chat, 'message_id', _msg, 'media_group_id', _mgid, 'removed', _gone, 'at', now()));
  end if;
  return _n;
end
$fn$;

-- ═══════════════════════════════ 5. Capture: the ONE engine that decides (I1) ═══════════════════════════════
create or replace function public.challenge_task_reply_kind(_chat bigint, _it jsonb, _user uuid, _from_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- C18: what a REAL reply points at, from the ledger and the posts table:
--   task_post (a sent / sent_via_sql / manual post of this chat) | own | own_receipt (the student's own receipt or
--   Mini App repost) | classmate | classmate_bot_msg (another student's receipt / Mini App repost) |
--   staff_or_anon | other_bot | none. Returns {kind, submission_id, task_id}.
declare
  _rid bigint;
  _p record;
  _o record;
  _s record;
begin
  if not coalesce((_it->>'is_real_reply')::boolean, false) or (_it->>'reply_to_message_id') is null then
    return jsonb_build_object('kind', 'none');
  end if;
  _rid := (_it->>'reply_to_message_id')::bigint;
  select p.task_id into _p from public.challenge_task_posts p
   where p.chat_id = _chat and p.message_id = _rid and p.kind = 'task' and p.state in ('sent', 'sent_via_sql', 'manual')
   limit 1;
  if found then
    return jsonb_build_object('kind', 'task_post', 'task_id', _p.task_id);
  end if;
  select m.user_id, m.source, m.outcome, m.submission_id into _o from public.challenge_task_messages m
   where m.chat_id = _chat and m.message_id = _rid;
  if found then
    if _o.user_id is not null and _o.user_id = _user then
      return jsonb_build_object('kind', case when _o.source = 'miniapp' then 'own_receipt' else 'own' end, 'submission_id', _o.submission_id);
    end if;
    if _o.source = 'miniapp' then return jsonb_build_object('kind', 'classmate_bot_msg'); end if;
    if _o.outcome in ('staff', 'anonymous') then return jsonb_build_object('kind', 'staff_or_anon'); end if;
    if _o.outcome = 'bot' then return jsonb_build_object('kind', 'other_bot'); end if;
    return jsonb_build_object('kind', 'classmate');
  end if;
  select s.id, s.user_id into _s from public.challenge_task_submissions s
   where s.receipt_chat_id = _chat and s.receipt_message_id = _rid
   limit 1;
  if found then
    return jsonb_build_object('kind', case when _s.user_id = _user then 'own_receipt' else 'classmate_bot_msg' end,
                              'submission_id', case when _s.user_id = _user then _s.id end);
  end if;
  if coalesce((_it->>'reply_from_anon')::boolean, false) then return jsonb_build_object('kind', 'staff_or_anon'); end if;
  if coalesce((_it->>'reply_from_is_bot')::boolean, false) then return jsonb_build_object('kind', 'other_bot'); end if;
  if (_it->>'reply_from_id')::bigint = _from_id then return jsonb_build_object('kind', 'own'); end if;
  if exists (select 1 from public.profiles pr
              where pr.telegram_id = (_it->>'reply_from_id')::bigint
                and pr.id in (select s2 from public.challenge_social_staff_ids() s2)) then
    return jsonb_build_object('kind', 'staff_or_anon');
  end if;
  return jsonb_build_object('kind', 'classmate');
end
$fn$;

create or replace function public.challenge_task_payload(_sub bigint, _outcome text, _reason text, _extra jsonb, _cfg jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The render-ready answer every entry point returns (§6.4 step 9). TypeScript only renders it (I1).
declare
  _s public.challenge_task_submissions;
  _t public.challenge_tasks;
  _d0 date;
  _rej int;
  _streak int := 0;
  _bonus int;
  _alts jsonb;
  _react text;
  _base jsonb := jsonb_build_object('status', 'ok', 'outcome', _outcome, 'reason', _reason);
begin
  if _sub is null then
    return _base || coalesce(_extra, '{}'::jsonb);
  end if;
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then
    return _base || coalesce(_extra, '{}'::jsonb);
  end if;
  select * into _t from public.challenge_tasks where id = _s.task_id;
  _d0 := public.challenge_task_local_date(_s.submitted_at);
  _rej := public.challenge_task_rejected_count(_s.user_id, _s.task_id);
  _streak := public.challenge_task_streak_current(_s.user_id, _t.course_id);
  select a.bonus into _bonus from public.challenge_task_streak_awards a
   where a.user_id = _s.user_id and a.course_id = _t.course_id and a.task_date = _t.task_date;
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', x.id, 'date', x.task_date,
           'rel', case _d0 - x.task_date when 0 then 'today' when 1 then 'yesterday' when 2 then 'day_before' else 'earlier' end)
           order by x.task_date desc), '[]'::jsonb)
    into _alts
    from public.challenge_tasks x
   where x.course_id = _t.course_id and x.status = 'approved' and x.id <> _t.id
     and x.task_date <= _d0 and x.task_date >= _d0 - coalesce((_cfg->>'late_days')::int, 2);
  _react := case
    when _outcome = 'appended_extra' then '👍'
    when _outcome in ('comment', 'ignored_kind', 'forward_other', 'daily_cap', 'outside_window', 'staff', 'anonymous', 'bot', 'appended_album') then null
    when _s.status = 'accepted' and _s.late_days = 0 and _streak >= 3 then '🔥'
    when _s.status = 'accepted' then '👍'
    when _s.status = 'checking' then '👀'
    when _s.status = 'needs_more' then '✍'
    when _s.status = 'rejected' then '🤔'
    else null end;
  return _base || jsonb_build_object(
    'user_id', _s.user_id,
    'group_id', _s.group_id,
    'submission', jsonb_build_object(
      'id', _s.id, 'status', _s.status, 'reason', _s.reason, 'missing', to_jsonb(_s.missing), 'hold_reason', _s.hold_reason,
      'points', _s.points_awarded, 'late_days', _s.late_days,
      'potential_points', public.challenge_task_points_for(_t, _s.late_days, _cfg),
      'attempts_left', greatest(0, coalesce((_cfg->>'max_attempts_per_task')::int, 3) - _rej),
      'attributed_via', _s.attributed_via, 'moved_count', _s.moved_count, 'submitted_at', _s.submitted_at,
      'receipt_message_id', _s.receipt_message_id, 'receipt_version', _s.receipt_version,
      'task', jsonb_build_object('id', _t.id, 'date', _t.task_date, 'day_no', public.challenge_task_day_no(_t),
                                 'type', _t.type, 'title', _t.title)),
    'slot', jsonb_build_object('task_id', _t.id, 'date', _t.task_date, 'kind', _s.attributed_via,
                               'rel', case _d0 - _t.task_date when 0 then 'today' when 1 then 'yesterday' when 2 then 'day_before' else 'earlier' end),
    'alternatives', _alts,
    'streak', jsonb_build_object('days', _streak, 'milestone_bonus', _bonus),
    'reaction', _react) || coalesce(_extra, '{}'::jsonb);
end
$fn$;

create or replace function public.challenge_task_note_once(_action text, _user uuid, _details jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Writes _action for _user at most once per Tashkent day. TRUE when this call wrote it (= the once-a-day hint).
begin
  perform pg_advisory_xact_lock(hashtext('ctask_once:' || _action || ':' || coalesce(_user::text, '-')));
  if exists (select 1 from public.admin_actions a
              where a.action = _action and a.target_user_id is not distinct from _user
                and a.created_at >= (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent')) then
    return false;
  end if;
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (null, _action, _user, coalesce(_details, '{}'::jsonb) || jsonb_build_object('at', now()));
  return true;
end
$fn$;

create or replace function public.challenge_task_capture(_msg jsonb, _source text, _opts jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.4. Called by the bot (PR-4, _source 'topic'), the reconciler ('reconciler') and the backfill ('backfill') with
-- a Telegram Message object. Idempotent per (chat, message_id): a replay answers 'duplicate' with the current state.
-- _opts.welcome = true: the bot just auto-registered this sender (the welcome is folded into the receipt, G7).
-- Outcomes: see §6.6. NO-ROW outcomes (disabled, unknown_sender, not_task_topic, no_group, sender_out_of_scope,
-- inactive) write nothing to the ledger; the reconciler re-derives them for 26 hours (C21).
declare
  _src text := coalesce(_source, 'topic');
  _cfg jsonb;
  _chat bigint;
  _mid bigint;
  _thread bigint;
  _ts timestamptz;
  _d date;
  _topic record;
  _row public.challenge_task_messages;
  _it jsonb;
  _kinds text[];
  _files text[];
  _from_id bigint;
  _uname text;
  _p record;
  _via text;
  _n int;
  _shaped boolean;
  _rk jsonb;
  _rkind text;
  _cr text;
  _outcome text;
  _reason text;
  _sub_id bigint;
  _create_task public.challenge_tasks;
  _create_via text;
  _t public.challenge_tasks;
  _s public.challenge_task_submissions;
  _max_att int;
  _mw interval;
  _exhausted boolean := false;
  _t0 public.challenge_tasks;
  _found boolean;
  _new_status text;
  _old_status text;
  _mode text := 'none';
  _hint jsonb;
  _own_url text;
  _welcome boolean := coalesce((_opts->>'welcome')::boolean, false);
  _media boolean;
  _cand record;
  _adopted int := 0;
begin
  if _src not in ('topic', 'reconciler', 'backfill') then
    raise exception using errcode = '22023', message = 'challenge_task_capture: _source must be topic | reconciler | backfill';
  end if;
  if _msg is null or jsonb_typeof(_msg) <> 'object'
     or (_msg->'chat'->>'id') !~ '^-?[0-9]{1,19}$' or (_msg->>'message_id') !~ '^[0-9]{1,19}$' then
    return jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', 'bad_message');
  end if;
  _chat := (_msg->'chat'->>'id')::bigint;
  _mid := (_msg->>'message_id')::bigint;
  _thread := case when (_msg->>'message_thread_id') ~ '^[0-9]{1,19}$' then (_msg->>'message_thread_id')::bigint end;

  -- 1. the topic: (chat, thread) of a daily-task topic. The CHAT is part of the key -- thread 10 is the daily
  --    topic of two different groups (5- and 6-GURUH).
  select t.group_id, t.course_id, t.chat_id, t.thread_id, t.is_test into _topic
    from public.challenge_task_topics() t where t.chat_id = _chat and t.thread_id = _thread limit 1;
  if not found then
    return jsonb_build_object('status', 'ok', 'outcome', 'not_task_topic');
  end if;

  -- 2. already processed
  select * into _row from public.challenge_task_messages where chat_id = _chat and message_id = _mid;
  if found then
    _cfg := public.challenge_tasks_config();
    return public.challenge_task_payload(_row.submission_id, 'duplicate', _row.outcome,
             jsonb_build_object('first_outcome', _row.outcome, 'receipt', jsonb_build_object('send', false, 'mode', 'none')), _cfg);
  end if;

  -- 3. the switches (C20): a pause writes NO row; the window is judged by DATES only
  _cfg := public.challenge_tasks_config();
  perform public.challenge_tasks_note_invalid(_cfg);
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('status', 'ok', 'outcome', 'disabled');
  end if;
  if (_msg->>'date') !~ '^[0-9]{1,12}$' then
    return jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', 'bad_date');
  end if;
  _ts := to_timestamp((_msg->>'date')::bigint);
  _d := public.challenge_task_local_date(_ts);
  _it := public.challenge_task_classify(_msg);
  _kinds := array(select jsonb_array_elements_text(_it->'kinds'));
  _files := array(select jsonb_array_elements_text(_it->'file_ids'));
  _from_id := case when (_msg->'from'->>'id') ~ '^[0-9]{1,19}$' then (_msg->'from'->>'id')::bigint end;
  _uname := nullif(lower(regexp_replace(coalesce(_msg->'from'->>'username', ''), '^@', '')), '');
  _media := coalesce((_it->>'media')::boolean, false);

  if ((_cfg->>'w_start_date') is not null and _d < (_cfg->>'w_start_date')::date)
     or ((_cfg->>'w_end_date') is not null and _d > (_cfg->>'w_end_date')::date) then
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, tg_user_id, sent_at, outcome, kinds, file_ids, item, media_group_id, source)
    values (_chat, _mid, _thread, _topic.group_id, _from_id, _ts, 'outside_window', _kinds, _files, _it, _it->>'media_group_id', _src)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'outside_window');
  end if;

  -- 4. the sender
  if _msg ? 'sender_chat' or _from_id = 1087968824 or _from_id is null then
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, tg_user_id, sent_at, outcome, kinds, file_ids, item, media_group_id, source)
    values (_chat, _mid, _thread, _topic.group_id, _from_id, _ts, 'anonymous', _kinds, _files, _it, _it->>'media_group_id', _src)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'anonymous');
  end if;
  if coalesce((_msg->'from'->>'is_bot')::boolean, false) then
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, tg_user_id, sent_at, outcome, kinds, file_ids, item, media_group_id, source)
    values (_chat, _mid, _thread, _topic.group_id, _from_id, _ts, 'bot', _kinds, _files, _it, _it->>'media_group_id', _src)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'bot');
  end if;

  -- C19: telegram_id, else ONE same-group profile with telegram_id NULL and this username (the post proves membership)
  select p.id, p.group_id, p.status::text as status, p.archived_at into _p from public.profiles p where p.telegram_id = _from_id;
  if found then
    _via := 'telegram_id';
  elsif _uname is not null then
    select count(*)::int into _n from public.profiles p
     where p.telegram_id is null and p.group_id = _topic.group_id
       and lower(replace(coalesce(p.telegram_username::text, ''), '@', '')) = _uname;
    if _n = 1 then
      select p.id, p.group_id, p.status::text as status, p.archived_at into _p from public.profiles p
       where p.telegram_id is null and p.group_id = _topic.group_id
         and lower(replace(coalesce(p.telegram_username::text, ''), '@', '')) = _uname;
      _via := 'username_match';
      perform public.challenge_task_note_once('challenge_task_username_match', _p.id, jsonb_build_object(
        'tg_user_id', _from_id, 'username', _uname, 'chat_id', _chat, 'message_id', _mid, 'group_id', _topic.group_id));
    end if;
  end if;
  if _via is null then
    _shaped := not coalesce((_it->>'forward_other')::boolean, false) and not coalesce((_it->>'question')::boolean, false)
               and (_media or coalesce((_it->>'ig_link')::boolean, false)
                    or coalesce((_it->>'text_len')::int, 0) >= coalesce((_cfg->>'min_text_chars')::int, 20));
    return jsonb_build_object('status', 'ok', 'outcome', 'unknown_sender', 'shaped', _shaped, 'tg_user_id', _from_id,
                              'username', _uname, 'group_id', _topic.group_id, 'chat_id', _chat, 'thread_id', _thread);
  end if;

  if exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = _p.id) then
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, tg_user_id, sent_at, outcome, resolved_via, kinds, file_ids, item, media_group_id, source)
    values (_chat, _mid, _thread, _topic.group_id, _p.id, _from_id, _ts, 'staff', _via, _kinds, _files, _it, _it->>'media_group_id', _src)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'staff');
  end if;

  -- HELD (C23, G13): no row; a DB-visible signal and a neutral hint once a day; retried for 26 hours
  _reason := case
    when _p.group_id is null then 'no_group'
    when not exists (select 1 from public.challenge_task_topics() t where t.group_id = _p.group_id) then 'sender_out_of_scope'
    when _p.status <> 'active' or _p.archived_at is not null then 'inactive'
  end;
  if _reason is not null then
    _found := public.challenge_task_note_once('challenge_task_sender_held', _p.id, jsonb_build_object(
      'reason', _reason, 'tg_user_id', _from_id, 'chat_id', _chat, 'thread_id', _thread, 'message_id', _mid,
      'group_id', _topic.group_id, 'profile_group_id', _p.group_id));
    return jsonb_build_object('status', 'ok', 'outcome', _reason, 'user_id', _p.id, 'resolved_via', _via,
                              'hint', case when _found then jsonb_build_object('kind', 'held', 'url', null) end);
  end if;

  if _p.group_id <> _topic.group_id then
    select g.daily_task_topic_url into _own_url from public.groups g where g.id = _p.group_id;
    _found := not exists (select 1 from public.challenge_task_messages m
                           where m.user_id = _p.id and m.outcome = 'wrong_group' and m.hinted
                             and public.challenge_task_local_date(m.sent_at) = _d);
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, tg_user_id, sent_at, outcome, resolved_via, kinds, file_ids, item, media_group_id, source, hinted)
    values (_chat, _mid, _thread, _topic.group_id, _p.id, _from_id, _ts, 'wrong_group', _via, _kinds, _files, _it, _it->>'media_group_id', _src, _found)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'wrong_group', 'user_id', _p.id, 'own_topic_url', _own_url,
                              'hint', case when _found then jsonb_build_object('kind', 'wrong_group', 'url', _own_url) end);
  end if;

  if _ts <= coalesce(public.challenge_task_void_at(_p.id), '-infinity'::timestamptz) then
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, tg_user_id, sent_at, outcome, resolved_via, kinds, file_ids, item, media_group_id, source)
    values (_chat, _mid, _thread, _topic.group_id, _p.id, _from_id, _ts, 'voided_sender', _via, _kinds, _files, _it, _it->>'media_group_id', _src)
    on conflict (chat_id, message_id) do nothing;
    return jsonb_build_object('status', 'ok', 'outcome', 'voided_sender', 'user_id', _p.id);
  end if;

  -- 5. one student at a time; re-check after the lock (the bot and the reconciler may race on one message)
  perform pg_advisory_xact_lock(hashtext('ctask:' || _p.id::text));
  select * into _row from public.challenge_task_messages where chat_id = _chat and message_id = _mid;
  if found then
    return public.challenge_task_payload(_row.submission_id, 'duplicate', _row.outcome,
             jsonb_build_object('first_outcome', _row.outcome, 'receipt', jsonb_build_object('send', false, 'mode', 'none')), _cfg);
  end if;

  -- 6. classify: silent final rows
  _rk := public.challenge_task_reply_kind(_chat, _it, _p.id, _from_id);
  _rkind := _rk->>'kind';
  _max_att := coalesce((_cfg->>'max_attempts_per_task')::int, 3);
  _mw := make_interval(mins => coalesce((_cfg->>'merge_window_min')::int, 5));
  if cardinality(_kinds) = 0 then
    _outcome := 'ignored_kind';
  elsif coalesce((_it->>'forward_other')::boolean, false) then
    _outcome := 'forward_other';
  else
    _cr := public.challenge_task_comment_reason(_it, _rkind, (_cfg->>'min_text_chars')::int, (_cfg->>'min_voice_sec')::int);
    if _cr is not null then
      _outcome := 'comment';
      _reason := _cr;
    elsif (select count(*) from public.challenge_task_messages m
            where m.user_id = _p.id and public.challenge_task_local_date(m.sent_at) = _d
              and m.outcome in ('created', 'appended', 'appended_album', 'appended_extra', 'adopted'))
          >= coalesce((_cfg->>'max_items_per_day')::int, 40) then
      _outcome := 'daily_cap';
    end if;
  end if;

  -- 7. attribution (option 1; the first rule that matches wins)
  if _outcome is null then
    -- R1 ALBUM
    if _it->>'media_group_id' is not null then
      select m.submission_id into _sub_id
        from public.challenge_task_messages m
        join public.challenge_task_submissions s on s.id = m.submission_id
       where m.chat_id = _chat and m.media_group_id = _it->>'media_group_id' and m.user_id = _p.id
         and s.status in ('needs_more', 'checking', 'accepted')
       order by m.id
       limit 1;
      if _sub_id is not null then
        _outcome := 'appended_album';
      end if;
    end if;
  end if;

  if _outcome is null and _rkind in ('own', 'own_receipt') and (_rk->>'submission_id') is not null then
    -- R2 REPLY TO OWN
    select * into _s from public.challenge_task_submissions
     where id = (_rk->>'submission_id')::bigint and status in ('needs_more', 'checking', 'accepted');
    if found then
      select * into _t from public.challenge_tasks where id = _s.task_id;
      if _ts < public.challenge_task_close_at(_t, _cfg) then
        _sub_id := _s.id;
        _outcome := 'appended';
      elsif _s.status = 'accepted' then
        _sub_id := _s.id;
        _outcome := 'appended_extra';           -- closed: never completes late work after close (I5)
      end if;
    end if;
  end if;

  if _outcome is null and _rkind = 'task_post' then
    -- R3 REPLY TO A TASK POST
    select * into _t from public.challenge_tasks where id = (_rk->>'task_id')::bigint;
    if _t.id is not null and _t.status = 'approved' and _t.course_id = _topic.course_id then
      select * into _s from public.challenge_task_submissions
       where user_id = _p.id and task_id = _t.id and status in ('needs_more', 'checking', 'accepted');
      if found and _ts < public.challenge_task_close_at(_t, _cfg) then
        _sub_id := _s.id;
        _outcome := 'appended';
      elsif found and _s.status = 'accepted' then
        _sub_id := _s.id;
        _outcome := 'appended_extra';
      elsif _ts >= public.challenge_task_close_at(_t, _cfg) or _d < _t.task_date then
        _outcome := 'no_slot';
        _reason := 'target_closed';
      elsif public.challenge_task_rejected_count(_p.id, _t.id) >= _max_att then
        _outcome := 'attempts_exhausted';
      else
        _create_task := _t;
        _create_via := 'reply_to_post';
      end if;
    end if;
  end if;

  if _outcome is null and _create_task.id is null then
    -- R4 BURST (spec §6.5; review R1): the newest LIVE submission -- an accepted one included -- still open, touched
    -- within merge_window_min, whose accepts the message's kinds intersect (or it is text): append. The 2nd, 3rd ...
    -- screenshot of one piece of work (Telegram users often send them one by one) is the SAME submission, never a paid
    -- missed day; a missed day is filled by the next post after the window (R6 c) or by replying to its post (R3).
    select s.* into _s
      from public.challenge_task_submissions s
      join public.challenge_tasks t on t.id = s.task_id
     where s.user_id = _p.id and s.status in ('needs_more', 'checking', 'accepted')
       and s.last_item_at >= _ts - _mw and s.last_item_at <= _ts + interval '1 minute'
       and _ts < public.challenge_task_close_at(t, _cfg)
       and ('text' = any(_kinds)
            or exists (select 1 from unnest(_kinds) k where public.challenge_task_accepts_kind(k) = any(t.accepts)))
     order by s.last_item_at desc
     limit 1;
    if found then
      _sub_id := _s.id;
      _outcome := 'appended';
    end if;
  end if;

  if _outcome is null and _create_task.id is null then
    -- R5 FIX-UP: the newest needs_more open submission whose missing[] this message supplies
    select s.* into _s
      from public.challenge_task_submissions s
      join public.challenge_tasks t on t.id = s.task_id
     where s.user_id = _p.id and s.status = 'needs_more'
       and _ts < public.challenge_task_close_at(t, _cfg)
       and public.challenge_task_supplies(t.requires, s.missing, _kinds)
     order by s.last_item_at desc
     limit 1;
    if found then
      _sub_id := _s.id;
      _outcome := 'appended';
    end if;
  end if;

  if _outcome is null and _create_task.id is null then
    -- R6 NEW SLOT: (a) Instagram-link affinity, (b) today, (c) missed (T-1, then T-2). A message may CREATE only
    -- per challenge_task_can_create (G3); a TEXT-ONLY message never takes (c).
    select t.* into _t0 from public.challenge_tasks t
     where t.course_id = _topic.course_id and t.status = 'approved' and t.task_date = _d;
    for _cand in
      select t.*, (t.task_date = _d) as is_today,
             exists (select 1 from public.challenge_task_submissions x
                      where x.user_id = _p.id and x.task_id = t.id and x.status in ('needs_more', 'checking', 'accepted')) as has_live,
             public.challenge_task_rejected_count(_p.id, t.id) as rejected
        from public.challenge_tasks t
       where t.course_id = _topic.course_id and t.status = 'approved'
         and t.task_date between _d - coalesce((_cfg->>'late_days')::int, 2) and _d
         and _ts >= public.challenge_task_open_at(t, _topic.group_id, _cfg)
         and _ts < public.challenge_task_close_at(t, _cfg)
       order by (case when (coalesce((_it->>'ig_link')::boolean, false) or coalesce((_it->>'ig_share')::boolean, false))
                           and t.type = 'instagram' then 0 else 1 end),
                t.task_date desc
    loop
      continue when _cand.has_live;
      if _cand.rejected >= _max_att then
        _exhausted := _exhausted or _cand.is_today;
        continue;
      end if;
      if (coalesce((_it->>'ig_link')::boolean, false) or coalesce((_it->>'ig_share')::boolean, false)) and _cand.type = 'instagram'
         and public.challenge_task_can_create(_cand.requires, _cand.accepts, _kinds || array['ig_link']) then
        select * into _create_task from public.challenge_tasks where id = _cand.id;
        _create_via := 'ig_link';
        exit;
      end if;
      if _cand.is_today then
        if public.challenge_task_can_create(_cand.requires, _cand.accepts, _kinds) then
          select * into _create_task from public.challenge_tasks where id = _cand.id;
          _create_via := 'today';
          exit;
        elsif not _media then
          _outcome := 'comment';
          _reason := 'text_for_media_task';
          exit;
        end if;
        continue;
      end if;
      if not _media then
        continue;                               -- text-only never fills a missed task
      end if;
      if public.challenge_task_can_create(_cand.requires, _cand.accepts, _kinds) then
        select * into _create_task from public.challenge_tasks where id = _cand.id;
        _create_via := 'missed';
        exit;
      end if;
    end loop;
  end if;

  if _outcome is null and _create_task.id is null then
    -- R7 NOTHING
    select s.* into _s
      from public.challenge_task_submissions s
      join public.challenge_tasks t on t.id = s.task_id
     where s.user_id = _p.id and s.status in ('needs_more', 'checking', 'accepted')
       and _ts < public.challenge_task_close_at(t, _cfg)
     order by s.last_item_at desc
     limit 1;
    if found then
      _sub_id := _s.id;
      _outcome := 'appended_extra';
    elsif _exhausted then
      _outcome := 'attempts_exhausted';
    else
      _outcome := 'no_slot';
      _reason := case when _t0.id is not null and _ts < public.challenge_task_open_at(_t0, _topic.group_id, _cfg)
                      then 'before_open' else 'no_open_task' end;
    end if;
  end if;

  -- 8. write: create or append, the ledger row, back-burst adoption, evaluate, settle, legacy swap
  if _create_task.id is not null then
    begin
      insert into public.challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status,
                                                     submitted_at, last_item_at, late_days, attempt_no)
      values (_create_task.id, _p.id, _topic.group_id, _src, _create_via, 'needs_more', _ts, _ts, _d - _create_task.task_date,
              1 + public.challenge_task_rejected_count(_p.id, _create_task.id))
      returning id into _sub_id;
      _outcome := 'created';
    exception when unique_violation then
      -- a racing writer created the live slot first (the per-student lock makes this a backstop): append to it
      select id into _sub_id from public.challenge_task_submissions
       where user_id = _p.id and task_id = _create_task.id and status in ('needs_more', 'checking', 'accepted');
      if _sub_id is null then
        raise;
      end if;
      _outcome := 'appended';
    end;
  end if;

  _found := _outcome in ('no_slot', 'attempts_exhausted')
            and not exists (select 1 from public.challenge_task_messages m
                             where m.user_id = _p.id and m.outcome = _outcome and m.hinted
                               and public.challenge_task_local_date(m.sent_at) = _d);
  insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, tg_user_id, sent_at, outcome, reason,
                                              resolved_via, submission_id, kinds, file_ids, item, media_group_id, is_real_reply,
                                              reply_to_message_id, reply_kind, source, hinted)
  values (_chat, _mid, _thread, _topic.group_id, _p.id, _from_id, _ts, _outcome, _reason, _via, _sub_id, _kinds, _files, _it,
          _it->>'media_group_id', coalesce((_it->>'is_real_reply')::boolean, false), (_it->>'reply_to_message_id')::bigint,
          _rkind, _src, _found);

  if _sub_id is not null and _outcome in ('created', 'appended', 'appended_album') then
    update public.challenge_task_submissions
       set last_item_at = greatest(last_item_at, _ts), updated_at = now()
     where id = _sub_id
    returning status into _old_status;
    if _outcome = 'created' then
      -- BACK-BURST: the sender's own silent text comments just before this message join the new submission
      with a as (
        update public.challenge_task_messages m
           set submission_id = _sub_id, outcome = 'adopted'
         where m.chat_id = _chat and m.user_id = _p.id and m.outcome = 'comment'
           and m.reason in ('short_text', 'text_for_media_task') and m.submission_id is null
           and not m.is_real_reply and m.sent_at >= _ts - _mw and m.sent_at <= _ts
        returning m.message_id, m.media_group_id
      )
      select count(*)::int into _adopted from a;
    end if;
    _new_status := public.challenge_task_evaluate(_sub_id, _cfg, true);
    if _new_status is distinct from _old_status or _new_status = 'accepted' then
      perform public.challenge_task_settle_ut(_p.id, (select task_id from public.challenge_task_submissions where id = _sub_id), _cfg);
    end if;
    perform public.challenge_task_legacy_swap(_p.id, _chat, _mid, _it->>'media_group_id');
    if _adopted > 0 then
      perform public.challenge_task_legacy_swap(_p.id, _chat, m.message_id, m.media_group_id)
         from public.challenge_task_messages m where m.submission_id = _sub_id and m.outcome = 'adopted';
    end if;
  end if;

  -- 9. the receipt decision (C7): one receipt per submission, edited as it changes. When this chat already had
  --    receipt_budget_per_chat_min receipts in the last minute: a plain on-time acceptance degrades to a reaction,
  --    and a receipt that carries the auto-registration WELCOME is never degraded but QUEUED to the worker, which
  --    paces it (§7.1, G7).
  _hint := case
    when _outcome = 'no_slot' and _found then jsonb_build_object('kind', 'no_slot_' || _reason, 'url', null)
    when _outcome = 'attempts_exhausted' and _found then jsonb_build_object('kind', 'attempts_exhausted', 'url', null)
  end;
  if _sub_id is not null and _outcome in ('created', 'appended', 'appended_album') then
    select * into _s from public.challenge_task_submissions where id = _sub_id;
    if _s.receipt_version > _s.receipt_sent_version then
      _mode := case when _s.receipt_message_id is not null then 'edit'
                    when _outcome = 'appended_album' then 'none'
                    when _outcome = 'appended' and _s.receipt_state = 'sending' then 'none'   -- the first receipt is in flight
                    else 'reply' end;
      if _mode = 'reply' and _src = 'topic'
         and (select count(*) from public.challenge_task_submissions x
               where x.receipt_chat_id = _chat and x.receipt_requested_at > now() - interval '1 minute')
             >= coalesce((_cfg->>'receipt_budget_per_chat_min')::int, 12) then
        _mode := case when _welcome then 'queued'
                      when _s.status = 'accepted' and _s.late_days = 0 then 'reaction'
                      else 'reply' end;
      end if;
      if _mode <> 'none' then
        update public.challenge_task_submissions set
          receipt_chat_id = _chat,
          receipt_reply_to = coalesce(receipt_reply_to, _mid),
          receipt_requested_at = now(),
          receipt_carries_welcome = receipt_carries_welcome or _welcome,
          receipt_state = case
            when not coalesce((_cfg->>'receipts')::boolean, true) or _mode = 'reaction' or _src = 'backfill' then 'suppressed'
            when _src = 'reconciler' then case when _ts > now() - make_interval(mins => coalesce((_cfg->>'backfill_receipt_max_age_min')::int, 120))
                                               then 'pending' else 'suppressed' end
            when _mode = 'queued' then 'pending'
            else 'sending' end,
          receipt_claimed_at = case when _src = 'topic' and _mode <> 'queued' then now() else receipt_claimed_at end,
          receipt_sent_version = case
            when not coalesce((_cfg->>'receipts')::boolean, true) or _mode = 'reaction' or _src = 'backfill'
                 or (_src = 'reconciler' and _ts <= now() - make_interval(mins => coalesce((_cfg->>'backfill_receipt_max_age_min')::int, 120)))
              then receipt_version else receipt_sent_version end,
          updated_at = now()
        where id = _sub_id
        returning * into _s;
      end if;
      if _src <> 'topic' or _s.receipt_state = 'suppressed' then
        _mode := case when _mode = 'reaction' then 'reaction' else 'none' end;
      end if;
      if _mode = 'queued' then
        insert into public.admin_actions (actor_user_id, action, target_user_id, details)
        values (null, 'challenge_task_receipt_queued', _p.id, jsonb_build_object('submission_id', _sub_id, 'chat_id', _chat,
                'reason', 'budget_welcome', 'at', now()));
      end if;
    end if;
  end if;

  return public.challenge_task_payload(_sub_id, _outcome, _reason, jsonb_build_object(
    'user_id', _p.id, 'resolved_via', _via, 'group_id', _topic.group_id, 'chat_id', _chat, 'message_id', _mid,
    'reply_kind', _rkind, 'adopted', _adopted,
    'receipt', jsonb_build_object('send', _mode in ('reply', 'edit'), 'mode', _mode,
                                  'carries_welcome', _welcome and _mode in ('reply', 'edit'),
                                  'reply_to_message_id', case when _sub_id is not null then (select receipt_reply_to from public.challenge_task_submissions where id = _sub_id) end,
                                  'receipt_message_id', case when _sub_id is not null then (select receipt_message_id from public.challenge_task_submissions where id = _sub_id) end,
                                  'version', case when _sub_id is not null then (select receipt_version from public.challenge_task_submissions where id = _sub_id) end),
    'hint', _hint), _cfg);
end
$fn$;

create or replace function public.challenge_task_item_edited(_msg jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- C17 / §6.9: the bot's edited_message hook (PR-4). An edit re-classifies a captured ITEM and re-evaluates its
-- submission unless that is already accepted (or final). An edit to a message that was never captured, or to a
-- row with no submission, is ignored.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _row public.challenge_task_messages;
  _it jsonb;
  _s public.challenge_task_submissions;
  _st text;
begin
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('status', 'ok', 'outcome', 'disabled');
  end if;
  if _msg is null or jsonb_typeof(_msg) <> 'object'
     or (_msg->'chat'->>'id') !~ '^-?[0-9]{1,19}$' or (_msg->>'message_id') !~ '^[0-9]{1,19}$' then
    return jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', 'bad_message');
  end if;
  select * into _row from public.challenge_task_messages
   where chat_id = (_msg->'chat'->>'id')::bigint and message_id = (_msg->>'message_id')::bigint;
  if not found then
    return jsonb_build_object('status', 'ok', 'outcome', 'ignored_uncaptured');
  end if;
  if _row.submission_id is null or _row.outcome not in ('created', 'appended', 'appended_album', 'adopted') then
    return jsonb_build_object('status', 'ok', 'outcome', 'ignored_not_item');
  end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _row.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _row.submission_id;
  if _s.status not in ('needs_more', 'checking') then
    return public.challenge_task_payload(_s.id, 'edit_ignored', 'submission_final', null, _cfg);
  end if;
  _it := public.challenge_task_classify(_msg);
  update public.challenge_task_messages
     set item = _it,
         kinds = array(select jsonb_array_elements_text(_it->'kinds')),
         file_ids = array(select jsonb_array_elements_text(_it->'file_ids')),
         edited_at = now()
   where id = _row.id;
  _st := public.challenge_task_evaluate(_s.id, _cfg, true);
  if _st is distinct from _s.status then
    perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
  end if;
  update public.challenge_task_submissions
     set receipt_state = case when receipt_message_id is not null and receipt_version > receipt_sent_version then 'pending' else receipt_state end
   where id = _s.id;
  return public.challenge_task_payload(_s.id, 'edited', null,
           jsonb_build_object('receipt', jsonb_build_object('send', false, 'mode', 'none')), _cfg);
end
$fn$;

-- ═══════════════════════════════ 6. Mini App entry points (PR-7 calls them as service_role) ═══════════════════════════════
create or replace function public.challenge_task_prepare_miniapp(_user uuid, _task_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- §6.10: may this student submit (for this task) from the Mini App right now? {ok, reason, task, topic, submission,
-- open_tasks}. Reasons: disabled | miniapp_off | no_profile | staff | held_sender (no_group / out of scope /
-- inactive) | no_task | wrong_course | not_open | closed | done | attempts_exhausted. 'impersonation' is enforced
-- client-side (impersonatingReadonly(), G12) and never reaches here.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _p record;
  _g record;
  _t public.challenge_tasks;
  _s public.challenge_task_submissions;
  _rej int;
  _open jsonb;
  _now timestamptz := now();
  _topic jsonb;
begin
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  if not coalesce((_cfg->>'miniapp')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'miniapp_off');
  end if;
  select p.id, p.group_id, p.status::text as status, p.archived_at into _p from public.profiles p where p.id = _user;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = _user) then
    return jsonb_build_object('ok', false, 'reason', 'staff');
  end if;
  select t.group_id, t.course_id, t.chat_id, t.thread_id into _g from public.challenge_task_topics() t where t.group_id = _p.group_id;
  if _p.group_id is null or not found or _p.status <> 'active' or _p.archived_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'held_sender',
                              'detail', case when _p.group_id is null then 'no_group' when _g.group_id is null then 'sender_out_of_scope' else 'inactive' end);
  end if;
  _topic := jsonb_build_object('group_id', _g.group_id, 'chat_id', _g.chat_id, 'thread_id', _g.thread_id,
                               'url', (select gr.daily_task_topic_url from public.groups gr where gr.id = _g.group_id));
  select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id, 'date', t.task_date, 'type', t.type, 'title', t.title,
                                               'late', t.task_date < public.challenge_task_local_date(_now)) order by t.task_date desc), '[]'::jsonb)
    into _open
    from public.challenge_tasks t
   where t.course_id = _g.course_id and t.status = 'approved'
     and _now >= public.challenge_task_open_at(t, _g.group_id, _cfg) and _now < public.challenge_task_close_at(t, _cfg)
     and not exists (select 1 from public.challenge_task_submissions x
                      where x.user_id = _user and x.task_id = t.id and x.status = 'accepted');
  if _task_id is null then
    return jsonb_build_object('ok', jsonb_array_length(_open) > 0, 'reason', case when jsonb_array_length(_open) = 0 then 'no_task' end,
                              'topic', _topic, 'open_tasks', _open);
  end if;
  select * into _t from public.challenge_tasks where id = _task_id and status = 'approved';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_task', 'topic', _topic, 'open_tasks', _open);
  end if;
  if _t.course_id <> _g.course_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong_course', 'topic', _topic, 'open_tasks', _open);
  end if;
  if _now < public.challenge_task_open_at(_t, _g.group_id, _cfg) then
    return jsonb_build_object('ok', false, 'reason', 'not_open', 'topic', _topic, 'open_tasks', _open);
  end if;
  if _now >= public.challenge_task_close_at(_t, _cfg) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'topic', _topic, 'open_tasks', _open);
  end if;
  select * into _s from public.challenge_task_submissions
   where user_id = _user and task_id = _t.id and status in ('needs_more', 'checking', 'accepted');
  if found and _s.status = 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'done', 'topic', _topic, 'submission_id', _s.id);
  end if;
  _rej := public.challenge_task_rejected_count(_user, _t.id);
  if _s.id is null and _rej >= coalesce((_cfg->>'max_attempts_per_task')::int, 3) then
    return jsonb_build_object('ok', false, 'reason', 'attempts_exhausted', 'topic', _topic);
  end if;
  return jsonb_build_object('ok', true, 'topic', _topic, 'open_tasks', _open,
    'task', jsonb_build_object('id', _t.id, 'date', _t.task_date, 'type', _t.type, 'title', _t.title, 'accepts', to_jsonb(_t.accepts),
                               'requires', _t.requires, 'late_days', public.challenge_task_local_date(_now) - _t.task_date,
                               'points', public.challenge_task_points_for(_t, public.challenge_task_local_date(_now) - _t.task_date, _cfg)),
    'submission', case when _s.id is not null then jsonb_build_object('id', _s.id, 'status', _s.status, 'missing', to_jsonb(_s.missing)) end);
end
$fn$;

create or replace function public.challenge_task_submit_claim(_user uuid, _request_id text, _task_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- G28: the Mini App's request claim. The CLAIM time is the submission time (a slow upload across midnight stays on
-- time). Idempotent: a second call with the same request_id answers the first claim.
declare
  _c public.challenge_task_submit_claims;
  _new boolean := false;
begin
  if coalesce(_request_id, '') !~ '^[A-Za-z0-9_-]{8,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request_id');
  end if;
  insert into public.challenge_task_submit_claims (user_id, request_id, task_id)
  values (_user, _request_id, _task_id)
  on conflict (user_id, request_id) do nothing
  returning * into _c;
  _new := found;
  if not _new then
    select * into _c from public.challenge_task_submit_claims where user_id = _user and request_id = _request_id;
  end if;
  return jsonb_build_object('ok', _c.task_id = _task_id, 'reason', case when _c.task_id <> _task_id then 'request_id_reused' end,
                            'new', _new, 'claimed_at', _c.claimed_at, 'state', _c.state, 'submission_id', _c.submission_id);
end
$fn$;

create or replace function public.challenge_task_submit_record(_user uuid, _request_id text, _messages jsonb, _error text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The edge function stores what it POSTED into the topic (the Bot API Message objects) before capturing, so the
-- reconciler's Mini App heal can finish a capture the function did not (I4). _error = the post failed.
declare
  _n int;
begin
  update public.challenge_task_submit_claims
     set state = case when _error is not null then 'failed' when state in ('claimed', 'posted') then 'posted' else state end,
         items = case when _error is null then coalesce(_messages, items) else items end,
         error = left(_error, 500), updated_at = now()
   where user_id = _user and request_id = _request_id and state in ('claimed', 'posted', 'failed');
  get diagnostics _n = row_count;
  if _error is not null then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_miniapp_post_failed', _user, jsonb_build_object('request_id', _request_id, 'error', left(_error, 300), 'at', now()));
  end if;
  return jsonb_build_object('ok', _n = 1);
end
$fn$;

create or replace function public.challenge_task_capture_miniapp(_user uuid, _task_id bigint, _request_id text,
                                                                 _claimed_at timestamptz, _messages jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.10 / G28: captures the messages the Mini App's edge function reposted into the student's topic (as the bot).
-- The task is explicit (like R3); submitted_at = _claimed_at, so lateness is judged by the claim, never by the post.
-- Idempotent per (user, request_id). Ledger rows: source 'miniapp', resolved_via 'miniapp'.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _prep jsonb;
  _c public.challenge_task_submit_claims;
  _p record;
  _g record;
  _t public.challenge_tasks;
  _s public.challenge_task_submissions;
  _sub_id bigint;
  _m jsonb;
  _it jsonb;
  _ts timestamptz;
  _outcome text;
  _first boolean := true;
  _st text;
  _old text;
  _rej int;
begin
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'miniapp')::boolean, false) then
    return jsonb_build_object('status', 'ok', 'outcome', 'disabled');
  end if;
  if jsonb_typeof(_messages) is distinct from 'array' or jsonb_array_length(_messages) = 0 or jsonb_array_length(_messages) > 10 then
    return jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', 'bad_messages');
  end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _user::text));
  select * into _c from public.challenge_task_submit_claims where user_id = _user and request_id = _request_id;
  if found and _c.state = 'captured' then
    return public.challenge_task_payload(_c.submission_id, 'duplicate', 'miniapp', null, _cfg);
  end if;
  _ts := coalesce(_c.claimed_at, _claimed_at, now());
  if _c.claimed_at is null and _ts > now() + interval '1 minute' then
    _ts := now();                               -- a caller-supplied claim time is never in the future
  end if;
  select p.id, p.group_id, p.status::text as status, p.archived_at into _p from public.profiles p where p.id = _user;
  select t.group_id, t.course_id, t.chat_id, t.thread_id into _g from public.challenge_task_topics() t where t.group_id = _p.group_id;
  select * into _t from public.challenge_tasks where id = _task_id and status = 'approved';
  if _p.id is null or _g.group_id is null or _t.id is null or _t.course_id <> _g.course_id
     or _p.status <> 'active' or _p.archived_at is not null
     or exists (select 1 from public.challenge_social_staff_ids() s(id) where s.id = _user) then
    -- the same gates as prepare_miniapp; a refusal is FINAL for this request (the heal never loops on it) and loud
    update public.challenge_task_submit_claims set state = 'failed', error = 'not_allowed', updated_at = now()
     where user_id = _user and request_id = _request_id and state in ('claimed', 'posted');
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_miniapp_refused', _user, jsonb_build_object('request_id', _request_id, 'task_id', _task_id, 'at', now()));
    return jsonb_build_object('status', 'ok', 'outcome', 'refused', 'reason', 'not_allowed');
  end if;

  if _ts >= public.challenge_task_close_at(_t, _cfg) or public.challenge_task_local_date(_ts) < _t.task_date then
    _outcome := 'no_slot';
  else
    select * into _s from public.challenge_task_submissions
     where user_id = _user and task_id = _t.id and status in ('needs_more', 'checking', 'accepted');
    if found then
      _sub_id := _s.id;
      _outcome := 'appended';
    else
      _rej := public.challenge_task_rejected_count(_user, _t.id);
      if _rej >= coalesce((_cfg->>'max_attempts_per_task')::int, 3) then
        _outcome := 'attempts_exhausted';
      else
        insert into public.challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status, submitted_at,
                                                       last_item_at, late_days, attempt_no, request_id, receipt_state)
        values (_t.id, _user, _g.group_id, 'miniapp', 'miniapp', 'needs_more', _ts, _ts,
                public.challenge_task_local_date(_ts) - _t.task_date, 1 + _rej, _request_id, 'suppressed')
        returning id into _sub_id;
        _outcome := 'created';
      end if;
    end if;
  end if;

  for _m in select value from jsonb_array_elements(_messages) loop
    continue when (_m->'chat'->>'id') !~ '^-?[0-9]{1,19}$' or (_m->>'message_id') !~ '^[0-9]{1,19}$';
    _it := public.challenge_task_classify(_m);
    insert into public.challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, tg_user_id, sent_at, outcome, reason,
                                                resolved_via, submission_id, kinds, file_ids, item, media_group_id, source)
    values ((_m->'chat'->>'id')::bigint, (_m->>'message_id')::bigint,
            case when (_m->>'message_thread_id') ~ '^[0-9]{1,19}$' then (_m->>'message_thread_id')::bigint end,
            _g.group_id, _user, null,
            coalesce(case when (_m->>'date') ~ '^[0-9]{1,12}$' then to_timestamp((_m->>'date')::bigint) end, _ts),
            case when _outcome = 'created' and not _first then 'appended' else _outcome end,
            case when _outcome in ('no_slot', 'attempts_exhausted') then 'miniapp' end,
            'miniapp', _sub_id, array(select jsonb_array_elements_text(_it->'kinds')),
            array(select jsonb_array_elements_text(_it->'file_ids')), _it, _it->>'media_group_id', 'miniapp')
    on conflict (chat_id, message_id) do nothing;
    _first := false;
  end loop;

  if _sub_id is not null then
    update public.challenge_task_submissions set last_item_at = greatest(last_item_at, _ts), updated_at = now()
     where id = _sub_id returning status into _old;
    _st := public.challenge_task_evaluate(_sub_id, _cfg, true);
    if _st is distinct from _old or _st = 'accepted' then
      perform public.challenge_task_settle_ut(_user, _t.id, _cfg);
    end if;
  end if;
  insert into public.challenge_task_submit_claims (user_id, request_id, task_id, claimed_at, state, items, submission_id)
  values (_user, _request_id, _t.id, _ts, 'captured', _messages, _sub_id)
  on conflict (user_id, request_id) do update
    set state = 'captured', items = coalesce(public.challenge_task_submit_claims.items, excluded.items),
        submission_id = excluded.submission_id, updated_at = now();
  return public.challenge_task_payload(_sub_id, _outcome, case when _outcome in ('no_slot', 'attempts_exhausted') then 'miniapp' end,
                                       jsonb_build_object('user_id', _user, 'group_id', _g.group_id), _cfg);
end
$fn$;

-- ═══════════════════════════════ 7. One-tap corrections (§6.11), student and admin RPCs ═══════════════════════════════
create or replace function public.challenge_task_move_core(_sub bigint, _target_task bigint, _actor uuid, _via text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Moves a submission to another task of the same course, or MERGES it into the student's live submission there.
-- I5: lateness is re-derived from the Tashkent date of submitted_at -- a move can never make work pay on time for a
-- date it was not posted on; a future task, or one closed relative to that date, is refused. At most
-- max_moves_per_submission moves. Both tasks are re-settled. Audited 'challenge_task_moved'.
-- R3: the STUDENT (actor = owner, not the admin path) can never move a REJECTED submission ('rejected_final': a
-- move re-judged it from scratch -- an appeal is an admin override), nor move once now() >= close_at of the source
-- OR the target task ('closed'). Admins (the logged tap override, admin_challenge_task_override) keep both.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _s public.challenge_task_submissions;
  _from public.challenge_tasks;
  _to public.challenge_tasks;
  _l public.challenge_task_submissions;
  _d0 date;
  _late int;
  _rej int;
  _target_id bigint;
  _student boolean;
begin
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  _student := _via is distinct from 'admin' and _actor is not distinct from _s.user_id;
  if _s.status not in ('needs_more', 'checking', 'accepted', 'rejected') then
    return jsonb_build_object('ok', false, 'reason', 'not_movable', 'status', _s.status);
  end if;
  if _student and _s.status = 'rejected' then
    return jsonb_build_object('ok', false, 'reason', 'rejected_final', 'status', _s.status);
  end if;
  select * into _from from public.challenge_tasks where id = _s.task_id;
  select * into _to from public.challenge_tasks where id = _target_task;
  if _to.id is null or _to.status <> 'approved' or _to.course_id <> _from.course_id then
    return jsonb_build_object('ok', false, 'reason', 'bad_target');
  end if;
  if _to.id = _from.id then
    return jsonb_build_object('ok', false, 'reason', 'same_task');
  end if;
  _d0 := public.challenge_task_local_date(_s.submitted_at);
  _late := _d0 - _to.task_date;
  if _late < 0 then
    return jsonb_build_object('ok', false, 'reason', 'future_task');
  end if;
  if _late > coalesce((_cfg->>'late_days')::int, 2)
     or (_student and (now() >= public.challenge_task_close_at(_from, _cfg) or now() >= public.challenge_task_close_at(_to, _cfg))) then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if _s.moved_count >= coalesce((_cfg->>'max_moves_per_submission')::int, 5) then
    return jsonb_build_object('ok', false, 'reason', 'too_many_moves');
  end if;

  select * into _l from public.challenge_task_submissions
   where user_id = _s.user_id and task_id = _to.id and status in ('needs_more', 'checking', 'accepted') for update;
  if found then
    -- MERGE: the items join the live submission there; the earliest submitted_at is kept (I5)
    update public.challenge_task_messages set submission_id = _l.id where submission_id = _s.id;
    update public.challenge_task_submissions
       set status = 'merged', merged_into = _l.id, points_awarded = 0, receipt_version = receipt_version + 1, updated_at = now()
     where id = _s.id;
    update public.challenge_task_submissions
       set submitted_at = least(submitted_at, _s.submitted_at),
           late_days = public.challenge_task_local_date(least(submitted_at, _s.submitted_at)) - _to.task_date,
           last_item_at = greatest(last_item_at, _s.last_item_at),
           status = case when status = 'accepted' then 'accepted' else 'needs_more' end,
           updated_at = now()
     where id = _l.id;
    perform public.challenge_task_evaluate(_l.id, _cfg, true);
    _target_id := _l.id;
  else
    _rej := public.challenge_task_rejected_count(_s.user_id, _to.id);
    if _rej >= coalesce((_cfg->>'max_attempts_per_task')::int, 3) then
      return jsonb_build_object('ok', false, 'reason', 'attempts_exhausted');
    end if;
    update public.challenge_task_submissions
       set task_id = _to.id, late_days = _late, attributed_via = 'moved', moved_count = moved_count + 1,
           status = 'needs_more', reason = null, missing = '{}', hold_reason = null, ig_shortcode = null, ig_handle_snapshot = null,
           check_token = null, check_claimed_at = null, check_result = null, attempt_no = 1 + _rej,
           receipt_version = receipt_version + 1, updated_at = now()
     where id = _s.id;
    perform public.challenge_task_evaluate(_s.id, _cfg, true);
    _target_id := _s.id;
  end if;
  update public.challenge_task_submissions
     set receipt_state = case when receipt_message_id is not null or receipt_state = 'pending' then 'pending' else receipt_state end
   where id in (_s.id, _target_id) and receipt_version > receipt_sent_version and receipt_state <> 'suppressed';
  perform public.challenge_task_settle_ut(_s.user_id, _from.id, _cfg);
  perform public.challenge_task_settle_ut(_s.user_id, _to.id, _cfg);
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (_actor, 'challenge_task_moved', _s.user_id, jsonb_build_object(
    'submission_id', _s.id, 'from_task', _from.id, 'to_task', _to.id, 'merged_into', case when _target_id <> _s.id then _target_id end,
    'late_days', _late, 'via', _via, 'at', now()));
  return public.challenge_task_payload(_target_id, 'moved', null, jsonb_build_object('ok', true, 'from_submission_id', _s.id), _cfg);
end
$fn$;

create or replace function public.challenge_task_withdraw_core(_sub bigint, _actor uuid, _via text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- "❌ Bu topshiriq emas": the submission stops counting (points removed); its items stay linked so restore can
-- bring it back (one tap, with undo). R3: the status, reason and actor are RECORDED (withdrawn_from /
-- withdrawn_reason / withdrawn_by) so restore returns exactly that; reason keeps the previous status for readers.
-- The STUDENT can never withdraw a REJECTED submission ('rejected_final': withdraw + restore re-judged it -- an admin
-- or AI verdict undone, max_attempts_per_task bypassed) nor withdraw once the task has closed ('closed').
declare
  _cfg jsonb := public.challenge_tasks_config();
  _s public.challenge_task_submissions;
  _t public.challenge_tasks;
  _student boolean;
begin
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  _student := _via is distinct from 'admin' and _actor is not distinct from _s.user_id;
  if _s.status not in ('needs_more', 'checking', 'accepted', 'rejected') then
    return jsonb_build_object('ok', false, 'reason', 'not_withdrawable', 'status', _s.status);
  end if;
  if _student and _s.status = 'rejected' then
    return jsonb_build_object('ok', false, 'reason', 'rejected_final', 'status', _s.status);
  end if;
  select * into _t from public.challenge_tasks where id = _s.task_id;
  if _student and now() >= public.challenge_task_close_at(_t, _cfg) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', _s.status);
  end if;
  update public.challenge_task_submissions
     set status = 'withdrawn', reason = _s.status, withdrawn_from = _s.status, withdrawn_reason = _s.reason,
         withdrawn_by = _actor, receipt_version = receipt_version + 1,
         receipt_state = case when receipt_message_id is not null then 'pending' else receipt_state end, updated_at = now()
   where id = _sub;
  perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (_actor, 'challenge_task_withdrawn', _s.user_id, jsonb_build_object('submission_id', _sub, 'task_id', _s.task_id,
          'previous_status', _s.status, 'via', _via, 'at', now()));
  return public.challenge_task_payload(_sub, 'withdrawn', null, jsonb_build_object('ok', true), _cfg);
end
$fn$;

create or replace function public.challenge_task_restore_core(_sub bigint, _actor uuid, _via text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Undo of withdraw. R3: returns the status and reason RECORDED at withdraw time -- never a re-judge (which turned an
-- admin / AI rejection, or a format acceptance under ai=false, into a fresh verdict to reroll). A restored 'checking'
-- gets a fresh check lease and fail-open clock (never an instant fail-open after a long withdrawal). A row withdrawn
-- before the recording existed (none live) is re-judged as before. Refused when a newer live submission already
-- holds that task's slot; the STUDENT cannot restore what an ADMIN withdrew ('withdrawn_by_admin') nor restore
-- once the task has closed ('closed').
declare
  _cfg jsonb := public.challenge_tasks_config();
  _s public.challenge_task_submissions;
  _t public.challenge_tasks;
  _st text;
  _student boolean;
begin
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  _student := _via is distinct from 'admin' and _actor is not distinct from _s.user_id;
  if _s.status <> 'withdrawn' then
    return jsonb_build_object('ok', false, 'reason', 'not_withdrawn', 'status', _s.status);
  end if;
  if _student and _s.withdrawn_by is distinct from _s.user_id then
    return jsonb_build_object('ok', false, 'reason', 'withdrawn_by_admin', 'status', _s.status);
  end if;
  select * into _t from public.challenge_tasks where id = _s.task_id;
  if _student and now() >= public.challenge_task_close_at(_t, _cfg) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'status', _s.status);
  end if;
  _st := coalesce(_s.withdrawn_from, case when _s.reason in ('needs_more', 'checking', 'accepted', 'rejected') then _s.reason end);
  if _st is distinct from 'rejected'
     and exists (select 1 from public.challenge_task_submissions x
                  where x.user_id = _s.user_id and x.task_id = _s.task_id and x.status in ('needs_more', 'checking', 'accepted')) then
    return jsonb_build_object('ok', false, 'reason', 'slot_taken');
  end if;
  if _st is null then
    update public.challenge_task_submissions set status = 'needs_more', reason = null, updated_at = now() where id = _sub;
    _st := public.challenge_task_evaluate(_sub, _cfg, true);
  else
    update public.challenge_task_submissions
       set status = _st,
           reason = _s.withdrawn_reason,
           check_version = check_version + case when _st = 'checking' then 1 else 0 end,
           check_token = case when _st = 'checking' then null else check_token end,
           check_claimed_at = case when _st = 'checking' then null else check_claimed_at end,
           checking_since = case when _st = 'checking' then now() else checking_since end,
           withdrawn_from = null, withdrawn_reason = null, withdrawn_by = null,
           receipt_version = receipt_version + 1, updated_at = now()
     where id = _sub;
  end if;
  update public.challenge_task_submissions
     set receipt_state = case when receipt_message_id is not null then 'pending' else receipt_state end
   where id = _sub and receipt_version > receipt_sent_version;
  perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (_actor, 'challenge_task_restored', _s.user_id, jsonb_build_object('submission_id', _sub, 'task_id', _s.task_id,
          'status', _st, 'via', _via, 'at', now()));
  return public.challenge_task_payload(_sub, 'restored', null, jsonb_build_object('ok', true), _cfg);
end
$fn$;

create or replace function public.challenge_task_tg_actor(_tg_user bigint, _sub bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The owner lock for dt: callbacks (SQL-side, never trusted to the client): the tapping Telegram user must own the
-- submission, else be an admin (a logged override). {allowed, actor, admin_override}.
declare
  _p record;
  _owner uuid;
begin
  select s.user_id into _owner from public.challenge_task_submissions s where s.id = _sub;
  select p.id into _p from public.profiles p where p.telegram_id = _tg_user;
  if _owner is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_found');
  end if;
  if _p.id is not null and _p.id = _owner then
    return jsonb_build_object('allowed', true, 'actor', _p.id, 'admin_override', false);
  end if;
  if _p.id is not null and (public.has_role(_p.id, 'admin'::public.app_role) or public.has_role(_p.id, 'superadmin'::public.app_role)) then
    return jsonb_build_object('allowed', true, 'actor', _p.id, 'admin_override', true);
  end if;
  return jsonb_build_object('allowed', false, 'reason', 'not_owner');
end
$fn$;

create or replace function public.challenge_task_move_by_tg(_tg_user bigint, _sub bigint, _target_task bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  _a jsonb := public.challenge_task_tg_actor(_tg_user, _sub);
begin
  if not (_a->>'allowed')::boolean then
    return jsonb_build_object('ok', false, 'reason', _a->>'reason');
  end if;
  if (_a->>'admin_override')::boolean then
    insert into public.admin_actions (actor_user_id, action, details)
    values ((_a->>'actor')::uuid, 'challenge_task_admin_override', jsonb_build_object('op', 'move', 'submission_id', _sub,
            'target_task', _target_task, 'tg_user', _tg_user, 'at', now()));
  end if;
  return public.challenge_task_move_core(_sub, _target_task, (_a->>'actor')::uuid, 'bot');
end
$fn$;

create or replace function public.challenge_task_withdraw_by_tg(_tg_user bigint, _sub bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  _a jsonb := public.challenge_task_tg_actor(_tg_user, _sub);
begin
  if not (_a->>'allowed')::boolean then
    return jsonb_build_object('ok', false, 'reason', _a->>'reason');
  end if;
  if (_a->>'admin_override')::boolean then
    insert into public.admin_actions (actor_user_id, action, details)
    values ((_a->>'actor')::uuid, 'challenge_task_admin_override', jsonb_build_object('op', 'withdraw', 'submission_id', _sub,
            'tg_user', _tg_user, 'at', now()));
  end if;
  return public.challenge_task_withdraw_core(_sub, (_a->>'actor')::uuid, 'bot');
end
$fn$;

create or replace function public.challenge_task_restore_by_tg(_tg_user bigint, _sub bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  _a jsonb := public.challenge_task_tg_actor(_tg_user, _sub);
begin
  if not (_a->>'allowed')::boolean then
    return jsonb_build_object('ok', false, 'reason', _a->>'reason');
  end if;
  if (_a->>'admin_override')::boolean then
    insert into public.admin_actions (actor_user_id, action, details)
    values ((_a->>'actor')::uuid, 'challenge_task_admin_override', jsonb_build_object('op', 'restore', 'submission_id', _sub,
            'tg_user', _tg_user, 'at', now()));
  end if;
  return public.challenge_task_restore_core(_sub, (_a->>'actor')::uuid, 'bot');
end
$fn$;

create or replace function public.my_challenge_task_move(_sub bigint, _target_task bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not exists (select 1 from public.challenge_task_submissions s where s.id = _sub and s.user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;
  return public.challenge_task_move_core(_sub, _target_task, auth.uid(), 'app');
end
$fn$;

create or replace function public.my_challenge_task_withdraw(_sub bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not exists (select 1 from public.challenge_task_submissions s where s.id = _sub and s.user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;
  return public.challenge_task_withdraw_core(_sub, auth.uid(), 'app');
end
$fn$;

create or replace function public.my_challenge_task_restore(_sub bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not exists (select 1 from public.challenge_task_submissions s where s.id = _sub and s.user_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;
  return public.challenge_task_restore_core(_sub, auth.uid(), 'app');
end
$fn$;

create or replace function public.my_challenge_tasks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The student's own daily-task page (PR-7): approved tasks up to today for their group's course, each with their
-- live/last submission, points, and the streak. Reads only the caller's rows.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _uid uuid := auth.uid();
  _g record;
  _today date := public.challenge_task_local_date(now());
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;
  select t.group_id, t.course_id into _g
    from public.profiles p join public.challenge_task_topics() t on t.group_id = p.group_id
   where p.id = _uid;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_in_challenge');
  end if;
  return jsonb_build_object(
    'ok', true, 'enabled', coalesce((_cfg->>'active')::boolean, false), 'miniapp', coalesce((_cfg->>'miniapp')::boolean, false),
    'topic_url', (select gr.daily_task_topic_url from public.groups gr where gr.id = _g.group_id),
    'streak', public.challenge_task_streak_current(_uid, _g.course_id),
    'points', coalesce((select sum(e.amount) from public.xp_events e
                         where e.user_id = _uid and e.reason in ('challenge_task', 'challenge_task_streak')), 0),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'date', t.task_date, 'day_no', public.challenge_task_day_no(t), 'type', t.type, 'title', t.title,
               'open', now() >= public.challenge_task_open_at(t, _g.group_id, _cfg) and now() < public.challenge_task_close_at(t, _cfg),
               'closed', now() >= public.challenge_task_close_at(t, _cfg),
               'submission', (select jsonb_build_object('id', s.id, 'status', s.status, 'points', s.points_awarded,
                                                        'late_days', s.late_days, 'missing', to_jsonb(s.missing), 'reason', s.reason,
                                                        'submitted_at', s.submitted_at)
                                from public.challenge_task_submissions s
                               where s.user_id = _uid and s.task_id = t.id and s.status not in ('merged')
                               order by (s.status in ('needs_more', 'checking', 'accepted')) desc, s.id desc
                               limit 1))
             order by t.task_date desc)
        from public.challenge_tasks t
       where t.course_id = _g.course_id and t.status = 'approved'
         and (t.task_date <= _today
              or exists (select 1 from public.challenge_task_submissions s2 where s2.user_id = _uid and s2.task_id = t.id))), '[]'::jsonb));
end
$fn$;

create or replace function public.my_telegram_write_access_granted()
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The Mini App's allows_write_to_pm (C15): the ONLY path that stamps profiles.telegram_write_access_at for a
-- student (the PR-0 guard refuses the column to a direct student write; this definer passes it).
begin
  if auth.uid() is null then return false; end if;
  update public.profiles set telegram_write_access_at = coalesce(telegram_write_access_at, now()) where id = auth.uid();
  return found;
end
$fn$;

create or replace function public.challenge_task_card(_task_id bigint, _tg_user bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- /start dt_<id> (PR-4): the task card -- the post text, WHERE to submit (the sender's own group's topic, G14),
-- and the sender's status for it.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _t public.challenge_tasks;
  _p record;
  _url text;
  _s record;
begin
  select * into _t from public.challenge_tasks where id = _task_id and status = 'approved';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_task');
  end if;
  select p.id, p.group_id into _p from public.profiles p where p.telegram_id = _tg_user;
  select g.daily_task_topic_url into _url from public.groups g
   where g.id = _p.group_id and g.course_id = _t.course_id and g.daily_task_topic_id is not null;
  select s.id, s.status, s.points_awarded, s.missing into _s from public.challenge_task_submissions s
   where s.user_id = _p.id and s.task_id = _t.id and s.status in ('needs_more', 'checking', 'accepted');
  return jsonb_build_object('ok', true, 'enabled', coalesce((_cfg->>'active')::boolean, false),
    'task', jsonb_build_object('id', _t.id, 'date', _t.task_date, 'type', _t.type, 'title', _t.title, 'day_no', public.challenge_task_day_no(_t)),
    'text', public.challenge_task_render_post(_t), 'topic_url', _url,
    'closed', now() >= public.challenge_task_close_at(_t, _cfg),
    'submission', case when _s.id is not null then jsonb_build_object('id', _s.id, 'status', _s.status, 'points', _s.points_awarded,
                                                                      'missing', to_jsonb(_s.missing)) end);
end
$fn$;

create or replace function public.admin_challenge_task_results(_task_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The admin results tab (PR-7): every submission for a task, by group, with names. Admin only.
begin
  if not (public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role)) then
    raise exception using errcode = '42501', message = 'admin_challenge_task_results: admin only';
  end if;
  return jsonb_build_object(
    'task', (select to_jsonb(t) - 'check_rubric' from public.challenge_tasks t where t.id = _task_id),
    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'user_id', s.user_id, 'name', p.name, 'group_id', s.group_id, 'group', g.name, 'status', s.status,
               'reason', s.reason, 'missing', to_jsonb(s.missing), 'hold_reason', s.hold_reason, 'points', s.points_awarded,
               'late_days', s.late_days, 'submitted_at', s.submitted_at, 'attributed_via', s.attributed_via, 'source', s.source,
               'moved_count', s.moved_count, 'items', (select count(*) from public.challenge_task_messages m where m.submission_id = s.id),
               'check_result', s.check_result)
             order by g.name, s.submitted_at)
        from public.challenge_task_submissions s
        join public.profiles p on p.id = s.user_id
        left join public.groups g on g.id = s.group_id
       where s.task_id = _task_id), '[]'::jsonb));
end
$fn$;

create or replace function public.admin_challenge_task_override(_sub bigint, _action text, _args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The audited admin override (appeals): accept | reject {reason} | move {task_id} | withdraw | restore.
-- Every call writes 'challenge_task_admin_override'. Admin only.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _s public.challenge_task_submissions;
  _res jsonb;
begin
  if not (public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role)) then
    raise exception using errcode = '42501', message = 'admin_challenge_task_override: admin only';
  end if;
  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (auth.uid(), 'challenge_task_admin_override', _s.user_id, jsonb_build_object(
    'op', _action, 'submission_id', _sub, 'args', coalesce(_args, '{}'::jsonb), 'previous_status', _s.status, 'at', now()));
  if _action = 'move' then
    return public.challenge_task_move_core(_sub, (_args->>'task_id')::bigint, auth.uid(), 'admin');
  elsif _action = 'withdraw' then
    return public.challenge_task_withdraw_core(_sub, auth.uid(), 'admin');
  elsif _action = 'restore' then
    return public.challenge_task_restore_core(_sub, auth.uid(), 'admin');
  elsif _action in ('accept', 'reject') then
    perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
    if _action = 'accept' and exists (select 1 from public.challenge_task_submissions x
                                       where x.user_id = _s.user_id and x.task_id = _s.task_id and x.id <> _sub
                                         and x.status in ('needs_more', 'checking', 'accepted')) then
      return jsonb_build_object('ok', false, 'reason', 'slot_taken');
    end if;
    update public.challenge_task_submissions
       set status = case when _action = 'accept' then 'accepted' else 'rejected' end,
           reason = case when _action = 'accept' then 'admin_override' else coalesce(nullif(_args->>'reason', ''), 'admin_override') end,
           hold_reason = null, missing = '{}',
           accepted_at = case when _action = 'accept' then now() else accepted_at end,
           receipt_version = receipt_version + 1,
           receipt_state = case when receipt_message_id is not null then 'pending' else receipt_state end,
           updated_at = now()
     where id = _sub;
    perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
    return public.challenge_task_payload(_sub, 'admin_' || _action, null, jsonb_build_object('ok', true), _cfg);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'bad_action');
end
$fn$;

-- ═══════════════════════════════ 8. Claim / record RPCs for the edge workers (PR-4/5/6); all inert while paused ═══════════════════════════════
create or replace function public.challenge_task_check_claim(_limit integer default 5)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- PR-6: leases 'checking' submissions (hold_reason NULL) to the AI checker for 10 minutes. Only when active AND
-- ai = true; respects ai_daily_budget_usd and ai_max_checks_per_user_day (a capped student waits). The AI gets
-- LABELS to return (I3): the verdict is decided by challenge_task_check_record.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _spent numeric;
  _out jsonb := '[]'::jsonb;
  _r record;
  _tok uuid;
  _day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent');
begin
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'ai')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'items', '[]'::jsonb);
  end if;
  select coalesce(sum(c.cost_usd), 0) into _spent from public.challenge_task_ai_calls c where c.created_at >= _day_start;
  if _spent >= coalesce((_cfg->>'ai_daily_budget_usd')::numeric, 3) then
    return jsonb_build_object('ok', false, 'reason', 'budget', 'spent_usd', _spent, 'items', '[]'::jsonb);
  end if;
  for _r in
    select s.id, s.user_id, s.task_id, s.check_version, s.ig_handle_snapshot, t.type, t.title, t.body, t.check_rubric,
           coalesce(t.requires_tag, t.type = 'instagram') as requires_tag
      from public.challenge_task_submissions s
      join public.challenge_tasks t on t.id = s.task_id
     where s.status = 'checking' and s.hold_reason is null
       and (s.check_token is null or s.check_claimed_at < now() - interval '10 minutes')
       and s.check_attempts < 5
       and (select count(*) from public.challenge_task_ai_calls c where c.user_id = s.user_id and c.created_at >= _day_start)
           < coalesce((_cfg->>'ai_max_checks_per_user_day')::int, 6)
     order by s.last_item_at
     limit greatest(1, least(coalesce(_limit, 5), 20))
     for update of s skip locked
  loop
    _tok := gen_random_uuid();
    update public.challenge_task_submissions
       set check_token = _tok, check_claimed_at = now(), check_attempts = check_attempts + 1, updated_at = now()
     where id = _r.id;
    _out := _out || jsonb_build_object(
      'submission_id', _r.id, 'token', _tok, 'version', _r.check_version, 'type', _r.type,
      'task', jsonb_build_object('id', _r.task_id, 'title', _r.title, 'body', _r.body, 'rubric', _r.check_rubric,
                                 'requires_tag', _r.requires_tag, 'tag_handle', _cfg->'ig'->>'tag_handle'),
      'handle', _r.ig_handle_snapshot,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('chat_id', m.chat_id, 'message_id', m.message_id, 'kinds', to_jsonb(m.kinds),
                                                            'file_ids', to_jsonb(m.file_ids), 'text', m.item->>'text',
                                                            'shortcode', m.item->>'shortcode', 'has_thumb', m.item->'has_thumb',
                                                            'mime', m.item->>'mime') order by m.sent_at, m.message_id), '[]'::jsonb)
                  from public.challenge_task_messages m
                 where m.submission_id = _r.id and m.outcome in ('created', 'appended', 'appended_album', 'adopted')));
  end loop;
  return jsonb_build_object('ok', true, 'items', _out);
end
$fn$;

create or replace function public.challenge_task_check_record(_sub bigint, _token uuid, _version integer, _result jsonb, _calls jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §9.6: SQL decides from the AI's labels. _result = {verdict: <strict schema>, link_status: ok|not_found|unverified|null,
-- dhash: [16-hex, ...]|null, fingerprint: ok|unavailable|null}. A stale token/version records the calls and
-- changes nothing. An invalid verdict releases the lease (retried; 5 attempts, then general work fails open via
-- the reconciler and instagram waits, alarmed).
declare
  _cfg jsonb := public.challenge_tasks_config();
  _s public.challenge_task_submissions;
  _t public.challenge_tasks;
  _v jsonb := _result->'verdict';
  _conf numeric;
  _decision text := 'accepted';
  _reason text;
  _c jsonb;
  _near boolean := false;
  _mind numeric;
  _seen text;
begin
  for _c in select value from jsonb_array_elements(case when jsonb_typeof(_calls) = 'array' then _calls else '[]'::jsonb end) loop
    insert into public.challenge_task_ai_calls (submission_id, user_id, provider, model, prompt_version, status, input_tokens,
                                                output_tokens, cost_usd, latency_ms, error)
    select _sub, s.user_id, left(_c->>'provider', 40), left(_c->>'model', 80), left(_c->>'prompt_version', 40),
           left(coalesce(_c->>'status', 'ok'), 40), public.challenge_cfg_int(_c->'input_tokens'), public.challenge_cfg_int(_c->'output_tokens'),
           greatest(coalesce(public.challenge_cfg_num(_c->'cost_usd'), 0), 0), public.challenge_cfg_int(_c->'latency_ms'), left(_c->>'error', 300)
      from public.challenge_task_submissions s where s.id = _sub;
  end loop;

  select * into _s from public.challenge_task_submissions where id = _sub;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  if _s.status <> 'checking' or _s.check_token is distinct from _token or _s.check_version <> coalesce(_version, -1) then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  select * into _t from public.challenge_tasks where id = _s.task_id;
  if not public.challenge_task_verdict_valid(_t.type, _v) then
    update public.challenge_task_submissions set check_token = null, check_claimed_at = null, updated_at = now() where id = _sub;
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_check_invalid', _s.user_id, jsonb_build_object('submission_id', _sub, 'attempts', _s.check_attempts, 'at', now()));
    return jsonb_build_object('ok', false, 'reason', 'invalid_verdict');
  end if;
  _conf := (_v->>'confidence')::numeric;

  if _t.type = 'general' then
    if (_v->>'manipulation')::boolean then _decision := 'rejected'; _reason := 'manipulation';
    elsif (_v->>'secret')::boolean then _decision := 'rejected'; _reason := 'secret';
    elsif (_v->>'inappropriate')::boolean then _decision := 'rejected'; _reason := 'inappropriate';
    elsif (_v->>'placeholder')::boolean then _decision := 'rejected'; _reason := 'placeholder';
    elsif _v->>'on_task' = 'no' and _conf >= coalesce((_cfg->'generic'->>'offtask_min_confidence')::numeric, 0.85) then
      _decision := 'rejected'; _reason := 'off_task';
    end if;
  else
    _seen := public.challenge_task_norm_handle(_v->>'handle_seen');
    -- dHash near-duplicates: a hard reject on instagram tasks only (C13)
    select min(public.challenge_task_dhash_distance(mine.hx, o.hy)) into _mind
      from jsonb_array_elements_text(case when jsonb_typeof(_result->'dhash') = 'array' then _result->'dhash' else '[]'::jsonb end) as mine(hx),
           lateral (select jsonb_array_elements_text(case when jsonb_typeof(x.check_result->'dhash') = 'array' then x.check_result->'dhash' else '[]'::jsonb end) as hy
                      from public.challenge_task_submissions x
                      join public.challenge_tasks xt on xt.id = x.task_id
                     where x.id <> _sub and xt.type = 'instagram' and x.check_result ? 'dhash'
                       and (x.user_id <> _s.user_id or x.task_id <> _s.task_id)) o;
    _near := _mind is not null and _mind <= coalesce((_cfg->'ig'->>'dhash_max_distance')::int, 4);
    if (_v->>'manipulation')::boolean then _decision := 'rejected'; _reason := 'manipulation';
    elsif (_v->>'inappropriate')::boolean then _decision := 'rejected'; _reason := 'inappropriate';
    elsif _near then _decision := 'rejected'; _reason := 'image_near_duplicate';
    elsif _result->>'link_status' = 'not_found' then _decision := 'rejected'; _reason := 'ig_link_invalid';
    elsif not (_v->>'is_instagram_screenshot')::boolean and _conf >= coalesce((_cfg->'ig'->>'min_confidence')::numeric, 0.6) then
      _decision := 'rejected'; _reason := 'not_instagram';
    elsif _seen is null then
      _decision := 'rejected'; _reason := 'ig_handle_not_visible';
    elsif public.challenge_task_edit_distance(_seen, coalesce(public.challenge_task_norm_handle(_s.ig_handle_snapshot::text),
                                                              (select public.challenge_task_norm_handle(p.instagram_username::text) from public.profiles p where p.id = _s.user_id)))
          > coalesce((_cfg->'ig'->>'handle_edit_distance')::int, 1)
          and _conf >= coalesce((_cfg->'ig'->>'min_confidence')::numeric, 0.6) then
      _decision := 'rejected'; _reason := 'ig_handle_mismatch';
    elsif coalesce(_t.requires_tag, true) and not (_v->>'tag_seen')::boolean
          and _conf >= coalesce((_cfg->'ig'->>'min_confidence')::numeric, 0.6) then
      _decision := 'rejected'; _reason := 'ig_tag_missing';
    elsif coalesce((_cfg->'ig'->>'require_recent')::boolean, true) and _v->>'posted_recently' = 'no'
          and _conf >= coalesce((_cfg->'ig'->>'recent_min_confidence')::numeric, 0.8) then
      _decision := 'rejected'; _reason := 'ig_post_old';
    end if;
  end if;

  update public.challenge_task_submissions
     set status = _decision, reason = coalesce(_reason, reason), check_token = null, check_claimed_at = null,
         checked_version = _version, checked_at = now(),
         check_result = jsonb_build_object('verdict', _v, 'link_status', _result->>'link_status',
                                           'dhash', case when jsonb_typeof(_result->'dhash') = 'array' then _result->'dhash' end,
                                           'fingerprint', _result->>'fingerprint', 'decision', _decision, 'reason', _reason),
         accepted_at = case when _decision = 'accepted' then now() else accepted_at end,
         receipt_version = receipt_version + 1,
         receipt_state = case when receipt_state = 'suppressed' and receipt_message_id is null then 'suppressed' else 'pending' end,
         updated_at = now()
   where id = _sub;
  perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
  -- the verdict also goes to the student's DM when they can be DM'd (C15): one 'result' row per check version
  if coalesce((_cfg->>'dm')::boolean, true) and public.challenge_task_dm_eligible(_s.user_id) then
    insert into public.challenge_task_outbox (user_id, kind, task_id, submission_id, dedupe_key, payload)
    values (_s.user_id, 'result', _s.task_id, _sub, 'result:' || _sub::text || ':' || coalesce(_version, 0)::text,
            jsonb_build_object('decision', _decision, 'reason', _reason))
    on conflict (dedupe_key) do nothing;
  end if;
  return public.challenge_task_payload(_sub, 'checked', _reason, jsonb_build_object('ok', true, 'decision', _decision), _cfg);
end
$fn$;

create or replace function public.challenge_task_receipt_claim(_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- PR-5 worker: receipts the bot did not send (reconciler captures, AI results, corrections, a crashed bot).
-- 'sending' older than 5 minutes is treated as pending (the bot died between capture and receipt_record).
declare
  _cfg jsonb := public.challenge_tasks_config();
  _out jsonb := '[]'::jsonb;
  _r record;
  _tok uuid;
begin
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'receipts')::boolean, true) then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'items', '[]'::jsonb);
  end if;
  for _r in
    select s.id from public.challenge_task_submissions s
     where s.receipt_version > s.receipt_sent_version
       and (s.receipt_state = 'pending' or (s.receipt_state = 'sending' and s.receipt_claimed_at < now() - interval '5 minutes'))
     order by s.updated_at
     limit greatest(1, least(coalesce(_limit, 10), 50))
     for update skip locked
  loop
    _tok := gen_random_uuid();
    update public.challenge_task_submissions
       set receipt_state = 'sending', receipt_token = _tok, receipt_claimed_at = now()
     where id = _r.id;
    _out := _out || (public.challenge_task_payload(_r.id, 'receipt', null, null, _cfg)
                     || jsonb_build_object('token', _tok,
                          'receipt', (select jsonb_build_object('chat_id', s.receipt_chat_id, 'reply_to_message_id', s.receipt_reply_to,
                                                                'receipt_message_id', s.receipt_message_id, 'version', s.receipt_version,
                                                                'carries_welcome', s.receipt_carries_welcome,
                                                                'mode', case when s.receipt_message_id is not null then 'edit' else 'reply' end)
                                        from public.challenge_task_submissions s where s.id = _r.id)));
  end loop;
  return jsonb_build_object('ok', true, 'items', _out);
end
$fn$;

create or replace function public.challenge_task_receipt_record(_sub bigint, _version integer, _chat_id bigint, _message_id bigint,
                                                                _ok boolean, _error text default null, _token uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The bot (after its immediate receipt) or the worker records what it sent. A newer version than the one sent
-- leaves the receipt 'pending' (the worker edits it). A failure is DB-visible (receipt_state failed + error).
declare
  _s public.challenge_task_submissions;
begin
  select * into _s from public.challenge_task_submissions where id = _sub for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if _token is not null and _s.receipt_token is distinct from _token then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  update public.challenge_task_submissions set
    receipt_chat_id = coalesce(_chat_id, receipt_chat_id),
    receipt_message_id = coalesce(_message_id, receipt_message_id),
    receipt_sent_version = case when _ok then greatest(receipt_sent_version, coalesce(_version, 0)) else receipt_sent_version end,
    receipt_state = case
      when not _ok then 'failed'
      when greatest(receipt_sent_version, coalesce(_version, 0)) < receipt_version then 'pending'
      else 'sent' end,
    receipt_error = case when _ok then null else left(_error, 300) end,
    receipt_token = null,
    updated_at = now()
  where id = _sub;
  if not _ok then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'challenge_task_receipt_failed', _s.user_id, jsonb_build_object('submission_id', _sub, 'error', left(_error, 300), 'at', now()));
  end if;
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function public.challenge_task_post_claim(_limit integer default 6)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- PR-5 worker: posts that are queued (by the PR-5 tick) or failed with attempts left, rendered by the same
-- function the approve guard measured. Lease 5 minutes.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _out jsonb := '[]'::jsonb;
  _r record;
  _tok uuid;
begin
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'post')::boolean, true) then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'items', '[]'::jsonb);
  end if;
  for _r in
    select p.task_id, p.group_id, p.kind, p.chat_id, p.thread_id, t.status as task_status
      from public.challenge_task_posts p
      join public.challenge_tasks t on t.id = p.task_id
     where (p.state = 'queued' or (p.state = 'failed' and p.attempts < 5)
            or (p.state = 'sending' and p.claimed_at < now() - interval '5 minutes'))
       and t.status = 'approved'
     order by p.created_at
     limit greatest(1, least(coalesce(_limit, 6), 20))
     for update of p skip locked
  loop
    _tok := gen_random_uuid();
    update public.challenge_task_posts
       set state = 'sending', claim_token = _tok, claimed_at = now(), attempts = attempts + 1
     where task_id = _r.task_id and group_id = _r.group_id and kind = _r.kind;
    _out := _out || jsonb_build_object('task_id', _r.task_id, 'group_id', _r.group_id, 'kind', _r.kind, 'token', _tok,
      'chat_id', _r.chat_id, 'thread_id', _r.thread_id,
      'start_param', 'dt_' || _r.task_id::text,                -- the post button: t.me/<bot>?start=dt_<id> (C10)
      'miniapp_link', _cfg->'miniapp_link',                     -- NULL until miniapp_onboarding (G28)
      'text', case when _r.kind = 'task' then (select public.challenge_task_render_post(t) from public.challenge_tasks t where t.id = _r.task_id) end,
      -- the 20:00 topic summary is anonymous counts only (no names)
      'summary', case when _r.kind = 'summary' then (
        select jsonb_build_object(
                 'done', count(*) filter (where s.status = 'accepted'),
                 'on_time', count(*) filter (where s.status = 'accepted' and s.late_days = 0),
                 'checking', count(*) filter (where s.status = 'checking'),
                 'needs_more', count(*) filter (where s.status = 'needs_more'),
                 'task_date', (select t.task_date from public.challenge_tasks t where t.id = _r.task_id))
          from public.challenge_task_submissions s
         where s.task_id = _r.task_id and s.group_id = _r.group_id) end);
  end loop;
  return jsonb_build_object('ok', true, 'items', _out);
end
$fn$;

create or replace function public.challenge_task_post_record(_task_id bigint, _group_id uuid, _kind text, _token uuid,
                                                             _message_id bigint, _error text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  _n int;
begin
  update public.challenge_task_posts
     set state = case when _message_id is not null then 'sent' else 'failed' end,
         message_id = coalesce(_message_id, message_id),
         sent_at = case when _message_id is not null then now() else sent_at end,
         error = case when _message_id is null then left(coalesce(_error, 'unknown'), 300) end,
         claim_token = null
   where task_id = _task_id and group_id = _group_id and kind = _kind and claim_token = _token and state = 'sending';
  get diagnostics _n = row_count;
  if _n = 1 and _message_id is null then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_post_failed', jsonb_build_object('task_id', _task_id, 'group_id', _group_id, 'kind', _kind,
            'error', left(_error, 300), 'at', now()));
  end if;
  return jsonb_build_object('ok', _n = 1, 'reason', case when _n = 0 then 'stale' end);
end
$fn$;

create or replace function public.challenge_task_outbox_claim(_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- PR-5 worker: due DMs, never inside quiet hours (Tashkent), only when active and dm = true.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _out jsonb := '[]'::jsonb;
  _r record;
  _tok uuid;
  _now time := (now() at time zone 'Asia/Tashkent')::time;
  _qs time := coalesce((_cfg->>'quiet_start')::time, time '22:00');
  _qe time := coalesce((_cfg->>'quiet_end')::time, time '08:00');
begin
  if not coalesce((_cfg->>'active')::boolean, false) or not coalesce((_cfg->>'dm')::boolean, true) then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'items', '[]'::jsonb);
  end if;
  if (_qs > _qe and (_now >= _qs or _now < _qe)) or (_qs < _qe and _now >= _qs and _now < _qe) then
    return jsonb_build_object('ok', false, 'reason', 'quiet_hours', 'items', '[]'::jsonb);
  end if;
  for _r in
    select o.id, o.user_id, o.kind, o.task_id, o.submission_id, o.payload, p.telegram_id
      from public.challenge_task_outbox o
      join public.profiles p on p.id = o.user_id
     where (o.state = 'pending' or (o.state = 'sending' and o.claimed_at < now() - interval '5 minutes'))
       and o.not_before <= now() and o.attempts < 5
     order by o.not_before
     limit greatest(1, least(coalesce(_limit, 20), 100))
     for update of o skip locked
  loop
    _tok := gen_random_uuid();
    update public.challenge_task_outbox set state = 'sending', claim_token = _tok, claimed_at = now(), attempts = attempts + 1 where id = _r.id;
    _out := _out || jsonb_build_object('id', _r.id, 'token', _tok, 'user_id', _r.user_id, 'telegram_id', _r.telegram_id,
                                       'kind', _r.kind, 'task_id', _r.task_id, 'submission_id', _r.submission_id, 'payload', _r.payload);
  end loop;
  return jsonb_build_object('ok', true, 'items', _out);
end
$fn$;

create or replace function public.challenge_task_outbox_record(_id bigint, _token uuid, _ok boolean, _error text default null, _terminal boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  _n int;
begin
  update public.challenge_task_outbox
     set state = case when _ok then 'sent' when _terminal then 'skipped' else 'failed' end,
         sent_at = case when _ok then now() end, error = case when _ok then null else left(_error, 300) end, claim_token = null
   where id = _id and claim_token = _token;
  get diagnostics _n = row_count;
  -- a failed row is retried by the next claim while attempts < 5 (claim picks 'failed' via pending re-queue below)
  update public.challenge_task_outbox set state = 'pending', not_before = now() + interval '10 minutes'
   where id = _id and state = 'failed' and attempts < 5;
  return jsonb_build_object('ok', _n = 1, 'reason', case when _n = 0 then 'stale' end);
end
$fn$;

create or replace function public.challenge_task_identity_pending(_limit integer default 20, _since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- PR-5 identity sweep input (G1, G9): shaped unknown senders still unresolved, and username-matched students whose
-- profile still has no telegram_id. The worker links / registers them through resolveGroupPoster.
declare
  _from timestamptz := coalesce(_since, now() - interval '26 hours');
begin
  return jsonb_build_object(
    'unknown', coalesce((
      select jsonb_agg(x order by x->>'last_at' desc) from (
        select jsonb_build_object('tg_user_id', r.tg_user_id, 'username', max(r.tg_username), 'chat_id', max(r.chat_id),
                                  'thread_id', max(r.thread_id), 'group_id', (array_agg(r.group_id))[1],
                                  'messages', count(*), 'last_at', max(r.last_at)) as x
          from public.challenge_task_retry r
         where r.outcome = 'unknown_sender' and r.shaped and coalesce(r.message_at, r.first_at) >= _from
         group by r.tg_user_id
         limit greatest(1, least(coalesce(_limit, 20), 200))) q), '[]'::jsonb),
    'username_matched', coalesce((
      select jsonb_agg(distinct jsonb_build_object('user_id', m.user_id, 'tg_user_id', m.tg_user_id, 'chat_id', m.chat_id))
        from public.challenge_task_messages m
        join public.profiles p on p.id = m.user_id
       where m.resolved_via = 'username_match' and p.telegram_id is null and m.sent_at >= _from), '[]'::jsonb));
end
$fn$;

-- ═══════════════════════════════ 9. Reassign (duplicate merge), the rolling reconciler, the backfill ═══════════════════════════════
create or replace function public.challenge_task_reassign_user(_from uuid, _to uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- G24: admin-merge-duplicates (PR-5) calls this BEFORE deleting the duplicate profile. Every daily-task row of
-- _from moves to _to. Two live submissions for one task: the EARLIER (submitted_at) keeps the slot, the later
-- becomes 'merged' into it (its items move along). _from's task ledger rows are removed and _to is re-settled.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _r record;
  _keep bigint;
  _drop bigint;
  _moved int := 0;
  _merged int := 0;
  _tasks bigint[];
  _t bigint;
  _course uuid;
begin
  if _from is null or _to is null or _from = _to then
    return jsonb_build_object('ok', false, 'reason', 'bad_arguments');
  end if;
  if not exists (select 1 from public.profiles where id = _from) or not exists (select 1 from public.profiles where id = _to) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  -- both students, in a stable order (no lock-order deadlock between two merges)
  perform pg_advisory_xact_lock(hashtext('ctask:' || least(_from::text, _to::text)));
  perform pg_advisory_xact_lock(hashtext('ctask:' || greatest(_from::text, _to::text)));

  for _r in
    select a.id as a_id, a.submitted_at as a_at, b.id as b_id, b.submitted_at as b_at
      from public.challenge_task_submissions a
      join public.challenge_task_submissions b on b.task_id = a.task_id and b.user_id = _to
     where a.user_id = _from
       and a.status in ('needs_more', 'checking', 'accepted') and b.status in ('needs_more', 'checking', 'accepted')
  loop
    if (_r.a_at, _r.a_id) < (_r.b_at, _r.b_id) then _keep := _r.a_id; _drop := _r.b_id; else _keep := _r.b_id; _drop := _r.a_id; end if;
    update public.challenge_task_messages set submission_id = _keep where submission_id = _drop;
    update public.challenge_task_submissions
       set status = 'merged', merged_into = _keep, points_awarded = 0, updated_at = now() where id = _drop;
    update public.challenge_task_submissions
       set status = case when status = 'accepted' then 'accepted' else 'needs_more' end, updated_at = now() where id = _keep;
    _merged := _merged + 1;
  end loop;

  select coalesce(array_agg(distinct task_id), '{}') into _tasks from public.challenge_task_submissions where user_id in (_from, _to);
  update public.challenge_task_submissions set user_id = _to, updated_at = now() where user_id = _from;
  get diagnostics _moved = row_count;
  update public.challenge_task_messages set user_id = _to where user_id = _from;
  update public.challenge_ig_posts set user_id = _to where user_id = _from;
  -- R2: a duplicate's award that pays a date, or any DAY, the canonical student's awards already pay is dropped
  -- (its ledger row goes with _from's below) -- a merge never pays one day twice
  delete from public.challenge_task_streak_awards a where a.user_id = _from
     and exists (select 1 from public.challenge_task_streak_awards b where b.user_id = _to and b.course_id = a.course_id
                    and (b.task_date = a.task_date or b.claimed_dates && a.claimed_dates));
  update public.challenge_task_streak_awards set user_id = _to where user_id = _from;
  delete from public.challenge_task_outbox o where o.user_id = _from
     and exists (select 1 from public.challenge_task_outbox x where x.user_id = _to and x.kind = o.kind and x.task_id is not distinct from o.task_id);
  update public.challenge_task_outbox set user_id = _to where user_id = _from;
  delete from public.challenge_task_submit_claims c where c.user_id = _from
     and exists (select 1 from public.challenge_task_submit_claims x where x.user_id = _to and x.request_id = c.request_id);
  update public.challenge_task_submit_claims set user_id = _to where user_id = _from;

  perform pg_advisory_xact_lock(hashtext('user_xp:' || _from::text));
  delete from public.xp_events where user_id = _from and reason in ('challenge_task', 'challenge_task_streak');
  perform public.challenge_task_rebuild_user_xp(_from);

  foreach _t in array _tasks loop
    perform public.challenge_task_evaluate(s.id, _cfg, true)
       from public.challenge_task_submissions s where s.user_id = _to and s.task_id = _t and s.status in ('needs_more', 'checking');
    perform public.challenge_task_settle_ut(_to, _t, _cfg);
  end loop;
  for _course in select distinct t.course_id from public.challenge_tasks t where t.id = any(_tasks) loop
    perform public.challenge_task_streak_recompute(_to, _course, _cfg);
  end loop;
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (null, 'challenge_task_user_reassigned', _to, jsonb_build_object('from', _from, 'to', _to, 'submissions', _moved,
          'merged', _merged, 'tasks', to_jsonb(_tasks), 'at', now()));
  return jsonb_build_object('ok', true, 'submissions', _moved, 'merged', _merged);
end
$fn$;

create or replace function public.challenge_task_note_retry(_msg jsonb, _res jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Records (or clears) the DB-visible retry state of one daily-topic message after a capture attempt.
begin
  if coalesce(_res->>'outcome', 'error') in ('disabled', 'unknown_sender', 'no_group', 'sender_out_of_scope', 'inactive', 'error') then
    insert into public.challenge_task_retry as r (chat_id, message_id, thread_id, group_id, tg_user_id, tg_username, message_at,
                                                  outcome, reason, shaped)
    values ((_msg->'chat'->>'id')::bigint, (_msg->>'message_id')::bigint,
            case when (_msg->>'message_thread_id') ~ '^[0-9]{1,19}$' then (_msg->>'message_thread_id')::bigint end,
            case when (_res->>'group_id') ~* '^[0-9a-f-]{36}$' then (_res->>'group_id')::uuid end,
            case when (_msg->'from'->>'id') ~ '^[0-9]{1,19}$' then (_msg->'from'->>'id')::bigint end,
            nullif(lower(_msg->'from'->>'username'), ''),
            case when (_msg->>'date') ~ '^[0-9]{1,12}$' then to_timestamp((_msg->>'date')::bigint) end,
            coalesce(_res->>'outcome', 'error'), left(_res->>'reason', 300), coalesce((_res->>'shaped')::boolean, false))
    on conflict (chat_id, message_id) do update
      set outcome = excluded.outcome, reason = excluded.reason, shaped = excluded.shaped,
          attempts = r.attempts + 1, last_at = now();
  else
    delete from public.challenge_task_retry
     where chat_id = (_msg->'chat'->>'id')::bigint and message_id = (_msg->>'message_id')::bigint;
  end if;
end
$fn$;

create or replace function public.reconcile_challenge_tasks(_since timestamptz default null, _at timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.12, cron 'challenge-tasks-reconcile' 4-59/10. TRY-lock: a miss writes 'challenge_task_reconcile_skipped', never
-- the heartbeat. While paused (enabled / challenge.enabled false) it writes the heartbeat ONLY (with the count of
-- messages waiting) and changes nothing -- inert. Active sections, each in its own sub-block:
--   (1) CAPTURE a FIXED rolling window (received_at >= now() - 26h, C21) anti-joined on the ledger, in message
--       order; no-row outcomes go to challenge_task_retry (I4). The window is time-based, so a pause never moves it.
--   (2) HOLDS / FAIL-OPEN: with ai = true, holds taken while ai was off are released to the checker, and GENERAL
--       checking work with no verdict after fail_open_after_min is accepted ('fail_open'). Instagram never.
--   (3) HANDLE re-evaluation (instagram work waiting for profiles.instagram_username).
--   (4) MINI APP HEAL (posted but never captured).  (5) LEDGER HEAL (voids, drift, orphans, streak awards).
--   (6) EXPIRE needs_more work whose task closed.
-- _at exists for the PGlite harness (a fixed clock); cron always passes nothing.
declare
  _cfg jsonb;
  _from timestamptz;
  _r record;
  _res jsonb;
  _by jsonb := '{}'::jsonb;
  _o text;
  _captured int := 0;
  _paused int := 0;
  _fail_open int := 0;
  _released int := 0;
  _handle int := 0;
  _heal_mini int := 0;
  _healed int := 0;
  _orphans int := 0;
  _expired int := 0;
  _awards int := 0;
  _errs jsonb := '{}'::jsonb;
  _s record;
  _st text;
  _hb jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('reconcile_challenge_tasks')) then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_task_reconcile_skipped', jsonb_build_object('reason', 'locked', 'at', now()));
    exception when others then null; end;
    return jsonb_build_object('skipped', 'locked');
  end if;
  _cfg := public.challenge_tasks_config();
  perform public.challenge_tasks_note_invalid(_cfg);
  _from := coalesce(_since, _at - interval '26 hours');

  if not coalesce((_cfg->>'active')::boolean, false) then
    select count(*)::int into _paused
      from public.webhook_inbox w
      join public.challenge_task_topics() t on t.chat_id = w.chat_id and t.thread_id = w.message_thread_id
     where w.update_type = 'message' and w.received_at >= _from
       and not coalesce((w.raw_update->'message'->'from'->>'is_bot')::boolean, false)
       and not exists (select 1 from public.challenge_task_messages m where m.chat_id = w.chat_id and m.message_id = w.message_id);
    _hb := jsonb_build_object('active', false, 'enabled', _cfg->'enabled', 'challenge_enabled', _cfg->'challenge_enabled',
                              'paused', _paused, 'config_invalid', _cfg->'invalid', 'at', now());
    insert into public.admin_actions (actor_user_id, action, details) values (null, 'challenge_task_reconciled', _hb);
    return _hb;
  end if;

  -- (1) CAPTURE
  begin
    for _r in
      select q.m
        from (select distinct on (w.chat_id, w.message_id) w.chat_id, w.message_id, w.raw_update->'message' as m, w.id
                from public.webhook_inbox w
                join public.challenge_task_topics() t on t.chat_id = w.chat_id and t.thread_id = w.message_thread_id
               where w.update_type = 'message' and w.received_at >= _from
                 and jsonb_typeof(w.raw_update->'message') = 'object'
                 and not coalesce((w.raw_update->'message'->'from'->>'is_bot')::boolean, false)
                 and not exists (select 1 from public.challenge_task_messages m where m.chat_id = w.chat_id and m.message_id = w.message_id)
               order by w.chat_id, w.message_id, w.id) q
       order by case when (q.m->>'date') ~ '^[0-9]{1,12}$' then (q.m->>'date')::bigint end nulls last, q.message_id
    loop
      begin
        _res := public.challenge_task_capture(_r.m, 'reconciler');
      exception when others then
        _res := jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', left(sqlerrm, 200));
      end;
      _o := coalesce(_res->>'outcome', 'error');
      _by := jsonb_set(_by, array[_o], to_jsonb(coalesce((_by->>_o)::int, 0) + 1));
      if _o not in ('disabled', 'unknown_sender', 'no_group', 'sender_out_of_scope', 'inactive', 'error', 'not_task_topic', 'duplicate') then
        _captured := _captured + 1;
      end if;
      perform public.challenge_task_note_retry(_r.m, _res);
    end loop;
    delete from public.challenge_task_retry r
     where exists (select 1 from public.challenge_task_messages m where m.chat_id = r.chat_id and m.message_id = r.message_id)
        or coalesce(r.message_at, r.first_at) < _at - interval '7 days';
  exception when others then
    _errs := _errs || jsonb_build_object('capture', left(sqlerrm, 200));
  end;

  -- (2) HOLDS / FAIL-OPEN (ai only)
  begin
    if coalesce((_cfg->>'ai')::boolean, false) then
      update public.challenge_task_submissions
         set hold_reason = null, check_token = null, check_claimed_at = null, checking_since = now(), updated_at = now()
       where status = 'checking' and hold_reason is not null;
      get diagnostics _released = row_count;
      for _s in
        select s.id, s.user_id, s.task_id
          from public.challenge_task_submissions s
          join public.challenge_tasks t on t.id = s.task_id
         where s.status = 'checking' and s.hold_reason is null and t.type = 'general' and s.checked_at is null
           and coalesce(s.checking_since, s.last_item_at) < _at - make_interval(mins => coalesce((_cfg->>'fail_open_after_min')::int, 60))
      loop
        perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
        update public.challenge_task_submissions
           set status = 'accepted', reason = 'fail_open', check_token = null, accepted_at = now(),
               receipt_version = receipt_version + 1,
               receipt_state = case when receipt_message_id is not null then 'pending' else receipt_state end, updated_at = now()
         where id = _s.id and status = 'checking';
        perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
        _fail_open := _fail_open + 1;
      end loop;
      if _fail_open > 0 then
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'challenge_task_fail_open', jsonb_build_object('count', _fail_open, 'at', now()));
      end if;
    end if;
  exception when others then
    _errs := _errs || jsonb_build_object('fail_open', left(sqlerrm, 200));
  end;

  -- (3) HANDLE re-evaluation
  begin
    for _s in
      select s.id, s.user_id, s.task_id, s.status
        from public.challenge_task_submissions s
        join public.profiles p on p.id = s.user_id
       where s.status = 'needs_more' and 'instagram_handle' = any(s.missing) and p.instagram_username is not null
    loop
      perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
      _st := public.challenge_task_evaluate(_s.id, _cfg, false);
      if _st is distinct from _s.status then
        update public.challenge_task_submissions
           set receipt_state = case when receipt_message_id is not null or receipt_state = 'pending' then 'pending' else receipt_state end
         where id = _s.id and receipt_version > receipt_sent_version and receipt_state <> 'suppressed';
        perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
      end if;
      _handle := _handle + 1;
    end loop;
  exception when others then
    _errs := _errs || jsonb_build_object('handle', left(sqlerrm, 200));
  end;

  -- (4) MINI APP HEAL
  begin
    for _s in
      select c.user_id, c.task_id, c.request_id, c.claimed_at, c.items
        from public.challenge_task_submit_claims c
       where c.state = 'posted' and c.items is not null and c.updated_at < _at - interval '2 minutes'
    loop
      begin
        _res := public.challenge_task_capture_miniapp(_s.user_id, _s.task_id, _s.request_id, _s.claimed_at, _s.items);
        if _res->>'outcome' not in ('disabled', 'error') then _heal_mini := _heal_mini + 1; end if;
      exception when others then
        _errs := _errs || jsonb_build_object('miniapp_' || _s.request_id, left(sqlerrm, 200));
      end;
    end loop;
    update public.challenge_task_submit_claims set state = 'abandoned', updated_at = now()
     where state = 'claimed' and claimed_at < _at - interval '30 minutes';
  exception when others then
    _errs := _errs || jsonb_build_object('miniapp', left(sqlerrm, 200));
  end;

  -- (5) LEDGER HEAL
  begin
    -- (a) work first posted at/before a student's newest void never pays (C8): needs_more/checking are closed here,
    --     accepted ones by settle below
    update public.challenge_task_submissions s
       set status = 'voided', reason = 'points_voided', receipt_version = receipt_version + 1, updated_at = now()
     where s.status in ('needs_more', 'checking')
       and s.submitted_at <= (select max(a.created_at) from public.admin_actions a
                               where a.action = 'challenge_points_voided' and a.target_user_id = s.user_id);
    -- (b) orphans: a task ledger row whose key names no task
    with d as (
      delete from public.xp_events e
       where e.reason = 'challenge_task'
         and (e.ref_key !~ '^ch_task:[0-9]{1,18}$'
              or not exists (select 1 from public.challenge_tasks t where t.id = substr(e.ref_key, 9)::bigint))
      returning e.user_id
    )
    select count(*)::int into _orphans from d;
    -- (c) drift: re-settle every (student, task) whose ledger row disagrees with the submissions
    for _s in
      select x.user_id, x.task_id from (
        select s.user_id, s.task_id
          from public.challenge_task_submissions s
          join public.challenge_tasks t on t.id = s.task_id
          left join public.xp_events e on e.user_id = s.user_id and e.ref_key = 'ch_task:' || s.task_id::text
         where s.status = 'accepted'
           and ((e.id is null and t.status = 'approved' and public.challenge_task_points_for(t, s.late_days, _cfg) > 0)
                or (e.id is not null and t.status <> 'approved')
                or (e.id is not null and (e.amount <> public.challenge_task_points_for(t, s.late_days, _cfg) or s.points_awarded <> e.amount))
                or s.submitted_at <= coalesce((select max(a.created_at) from public.admin_actions a
                                                where a.action = 'challenge_points_voided' and a.target_user_id = s.user_id), '-infinity'::timestamptz))
        union
        select e.user_id, substr(e.ref_key, 9)::bigint
          from public.xp_events e
         where e.reason = 'challenge_task' and e.ref_key ~ '^ch_task:[0-9]{1,18}$'
           and not exists (select 1 from public.challenge_task_submissions s
                            where s.user_id = e.user_id and s.task_id = substr(e.ref_key, 9)::bigint and s.status = 'accepted')
        union
        select s.user_id, s.task_id from public.challenge_task_submissions s where s.status <> 'accepted' and s.points_awarded > 0
      ) x
    loop
      perform public.challenge_task_settle_ut(_s.user_id, _s.task_id, _cfg);
      _healed := _healed + 1;
    end loop;
    -- (d) streak awards: every student with on-time work touched in the window; a sticky award that lost its
    --     ledger row (not by a void) gets it back
    for _s in
      select distinct s.user_id, t.course_id
        from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
       where s.status = 'accepted' and s.late_days = 0 and s.updated_at >= _from
    loop
      perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
      perform public.challenge_task_streak_recompute(_s.user_id, _s.course_id, _cfg);
    end loop;
    for _s in
      select a.user_id, a.xp_ref_key, a.bonus, a.created_at
        from public.challenge_task_streak_awards a
       where not exists (select 1 from public.xp_events e where e.user_id = a.user_id and e.ref_key = a.xp_ref_key)
         and a.created_at > coalesce((select max(v.created_at) from public.admin_actions v
                                       where v.action = 'challenge_points_voided' and v.target_user_id = a.user_id), '-infinity'::timestamptz)
    loop
      perform pg_advisory_xact_lock(hashtext('ctask:' || _s.user_id::text));
      perform pg_advisory_xact_lock(hashtext('user_xp:' || _s.user_id::text));
      insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
      values (_s.user_id, _s.bonus, 'challenge_task_streak', _s.xp_ref_key, public.challenge_task_award_ts(_s.created_at))
      on conflict (user_id, ref_key) do nothing;
      perform public.challenge_task_rebuild_user_xp(_s.user_id);
      _awards := _awards + 1;
    end loop;
  exception when others then
    _errs := _errs || jsonb_build_object('ledger', left(sqlerrm, 200));
  end;

  -- (6) EXPIRE: needs_more work whose task has closed
  begin
    with x as (
      update public.challenge_task_submissions s
         set status = 'expired', receipt_version = receipt_version + 1,
             receipt_state = case when receipt_message_id is not null then 'pending' else receipt_state end, updated_at = now()
        from public.challenge_tasks t
       where t.id = s.task_id and s.status = 'needs_more' and _at >= public.challenge_task_close_at(t, _cfg)
      returning s.id
    )
    select count(*)::int into _expired from x;
  exception when others then
    _errs := _errs || jsonb_build_object('expire', left(sqlerrm, 200));
  end;

  _hb := jsonb_build_object(
    'active', true, 'from', _from, 'captured', _captured, 'by_outcome', _by,
    'retry_pending', (select count(*) from public.challenge_task_retry r
                       where r.outcome in ('error', 'disabled') and r.first_at < now() - interval '20 minutes'),
    'held', (select count(distinct r.tg_user_id) from public.challenge_task_retry r
              where r.outcome in ('no_group', 'sender_out_of_scope', 'inactive') and coalesce(r.message_at, r.first_at) >= _from),
    'unknown', (select count(distinct r.tg_user_id) from public.challenge_task_retry r
                 where r.outcome = 'unknown_sender' and r.shaped and coalesce(r.message_at, r.first_at) >= _from),
    'paused', 0, 'fail_open', _fail_open, 'holds_released', _released, 'handle_reeval', _handle, 'miniapp_healed', _heal_mini,
    'healed', _healed, 'orphans_removed', _orphans, 'streak_awards_healed', _awards, 'expired', _expired,
    'config_invalid', _cfg->'invalid', 'section_errors', _errs, 'at', now());
  insert into public.admin_actions (actor_user_id, action, details) values (null, 'challenge_task_reconciled', _hb);
  return _hb;
end
$fn$;

create or replace function public.challenge_tasks_backfill(_from timestamptz, _to timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §6.13 (service_role / migration only; idempotent). Captures every daily-topic message received in [_from, _to)
-- that has no ledger row (source 'backfill': receipts suppressed), and first re-opens 'no_slot' rows in that
-- window so retro tasks entered later can adopt them. One 'backfill_summary' outbox row per DM-eligible credited
-- student. Senders it still cannot resolve are reported as 'challenge_task_backfill_unresolved' (G9).
declare
  _cfg jsonb := public.challenge_tasks_config();
  _r record;
  _res jsonb;
  _o text;
  _by jsonb := '{}'::jsonb;
  _reopened int := 0;
  _unres jsonb;
  _credited uuid[];
  _summaries int := 0;
  _run_start timestamptz := now();          -- rows this run wrote carry now() (one transaction)
begin
  if _from is null or _to is null or _to <= _from then
    raise exception using errcode = '22023', message = 'challenge_tasks_backfill: need _from < _to';
  end if;
  perform pg_advisory_xact_lock(hashtext('reconcile_challenge_tasks'));
  if not coalesce((_cfg->>'active')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  with d as (
    delete from public.challenge_task_messages m
     where m.outcome = 'no_slot' and m.source <> 'miniapp' and m.submission_id is null
       and exists (select 1 from public.webhook_inbox w
                    where w.chat_id = m.chat_id and w.message_id = m.message_id and w.update_type = 'message'
                      and w.received_at >= _from and w.received_at < _to)
    returning 1
  )
  select count(*)::int into _reopened from d;

  for _r in
    select q.m
      from (select distinct on (w.chat_id, w.message_id) w.chat_id, w.message_id, w.raw_update->'message' as m, w.id
              from public.webhook_inbox w
              join public.challenge_task_topics() t on t.chat_id = w.chat_id and t.thread_id = w.message_thread_id
             where w.update_type = 'message' and w.received_at >= _from and w.received_at < _to
               and jsonb_typeof(w.raw_update->'message') = 'object'
               and not coalesce((w.raw_update->'message'->'from'->>'is_bot')::boolean, false)
               and not exists (select 1 from public.challenge_task_messages m where m.chat_id = w.chat_id and m.message_id = w.message_id)
             order by w.chat_id, w.message_id, w.id) q
     order by case when (q.m->>'date') ~ '^[0-9]{1,12}$' then (q.m->>'date')::bigint end nulls last, q.message_id
  loop
    begin
      _res := public.challenge_task_capture(_r.m, 'backfill');
    exception when others then
      _res := jsonb_build_object('status', 'error', 'outcome', 'error', 'reason', left(sqlerrm, 200));
    end;
    _o := coalesce(_res->>'outcome', 'error');
    _by := jsonb_set(_by, array[_o], to_jsonb(coalesce((_by->>_o)::int, 0) + 1));
    perform public.challenge_task_note_retry(_r.m, _res);
  end loop;

  select coalesce(array_agg(distinct s.user_id), '{}') into _credited
    from public.challenge_task_submissions s
   where s.source = 'backfill' and s.created_at >= _run_start and s.status in ('accepted', 'checking', 'needs_more');
  insert into public.challenge_task_outbox (user_id, kind, dedupe_key, payload)
  select u, 'backfill_summary', 'backfill_summary:' || u::text || ':' || public.challenge_task_local_date(_from)::text,
         jsonb_build_object('from', _from, 'to', _to,
                            'submissions', (select count(*) from public.challenge_task_submissions s where s.user_id = u and s.source = 'backfill'),
                            'points', (select coalesce(sum(s.points_awarded), 0) from public.challenge_task_submissions s
                                        where s.user_id = u and s.source = 'backfill'))
    from unnest(_credited) u
   where public.challenge_task_dm_eligible(u)
  on conflict (dedupe_key) do nothing;
  get diagnostics _summaries = row_count;

  select coalesce(jsonb_agg(jsonb_build_object('tg_user_id', x.tg_user_id, 'username', x.u, 'outcome', x.o, 'messages', x.n)), '[]'::jsonb)
    into _unres
    from (select r.tg_user_id, max(r.tg_username) as u, max(r.outcome) as o, count(*) as n
            from public.challenge_task_retry r
           where r.last_at >= _run_start
             and r.outcome in ('unknown_sender', 'no_group', 'sender_out_of_scope', 'inactive', 'error')
           group by r.tg_user_id) x;
  if jsonb_array_length(_unres) > 0 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_backfill_unresolved', jsonb_build_object('from', _from, 'to', _to, 'senders', _unres,
            'counts', jsonb_build_object('senders', jsonb_array_length(_unres)), 'at', now()));
  end if;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_task_backfill_run', jsonb_build_object('from', _from, 'to', _to, 'by_outcome', _by,
          'reopened_no_slot', _reopened, 'credited_students', cardinality(_credited), 'summaries_queued', _summaries,
          'unresolved_senders', jsonb_array_length(_unres), 'at', now()));
  return jsonb_build_object('ok', true, 'by_outcome', _by, 'reopened_no_slot', _reopened, 'credited_students', cardinality(_credited),
                            'summaries_queued', _summaries, 'unresolved', _unres);
end
$fn$;

-- ═══════════════════════════════ 10. Guards: tasks lock (guard v2) and the Instagram handle lock (G2) ═══════════════════════════════
create or replace function public.challenge_tasks_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
-- §6.14 guard v2, as its OWN trigger (trg_challenge_tasks_zz_lock sorts after v1's trg_challenge_tasks_guard, which
-- stays byte-identical). Once a task was POSTED (sent / sent_via_sql / manual) or has a live submission, what a
-- submission was judged against is frozen: type, accepts, requires, points, requires_tag, min_text_chars,
-- min_duration_sec, task_date, course_id. It can no longer be un-approved (only cancelled -- which pays 0 and is
-- audited, reversible by re-approving). Wording (title, body, hints, rubric) stays editable.
declare
  _posted boolean;
  _live boolean;
begin
  _posted := exists (select 1 from public.challenge_task_posts p
                      where p.task_id = OLD.id and p.state in ('sent', 'sent_via_sql', 'manual'));
  _live := exists (select 1 from public.challenge_task_submissions s
                    where s.task_id = OLD.id and s.status in ('needs_more', 'checking', 'accepted'));
  if not (_posted or _live) then
    return NEW;
  end if;
  if NEW.type is distinct from OLD.type or NEW.accepts is distinct from OLD.accepts or NEW.requires is distinct from OLD.requires
     or NEW.points is distinct from OLD.points or NEW.requires_tag is distinct from OLD.requires_tag
     or NEW.min_text_chars is distinct from OLD.min_text_chars or NEW.min_duration_sec is distinct from OLD.min_duration_sec
     or NEW.task_date is distinct from OLD.task_date or NEW.course_id is distinct from OLD.course_id then
    raise exception using errcode = 'P0001',
      message = 'Bu vazifa allaqachon e’lon qilingan yoki topshiriqlari bor — turi, formatlari, ball va sanasini o‘zgartirib bo‘lmaydi';
  end if;
  if OLD.status = 'approved' and NEW.status = 'draft' then
    raise exception using errcode = 'P0001',
      message = 'E’lon qilingan / topshiriqlari bor vazifani qoralamaga qaytarib bo‘lmaydi — kerak bo‘lsa «Bekor qilish»';
  end if;
  if NEW.status is distinct from OLD.status and (NEW.status = 'cancelled' or OLD.status = 'cancelled') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (auth.uid(), 'challenge_task_status_changed_with_submissions', jsonb_build_object(
      'task_id', OLD.id, 'task_date', OLD.task_date, 'from', OLD.status, 'to', NEW.status, 'posted', _posted, 'live', _live, 'at', now()));
  end if;
  return NEW;
end
$fn$;

drop trigger if exists trg_challenge_tasks_zz_lock on public.challenge_tasks;
create trigger trg_challenge_tasks_zz_lock
  before update on public.challenge_tasks
  for each row execute function public.challenge_tasks_lock();

create or replace function public.challenge_task_ig_handle_locked(_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- TRUE when ig.lock_handle_after_accept is on and the student has an accepted instagram submission. Answers only
-- about the CALLER (auth.uid()); an admin is never locked. EXECUTE: authenticated (the invoker trigger calls it).
begin
  if _user is null or auth.uid() is null or _user <> auth.uid() then
    return false;
  end if;
  if public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role) then
    return false;
  end if;
  return coalesce((public.challenge_tasks_config()->'ig'->>'lock_handle_after_accept')::boolean, true)
     and exists (select 1 from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
                  where s.user_id = _user and s.status = 'accepted' and t.type = 'instagram');
end
$fn$;

create or replace function public.challenge_task_ig_handle_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
-- §6.14b (G2) as its OWN invoker trigger (trg_profiles_zz_ig_handle_lock): after the first ACCEPTED instagram
-- submission a student can no longer change their own instagram_username (it is what the screenshot is matched
-- against). Privileged callers (service_role, definer functions, migrations: current_user not authenticated/anon)
-- and admins pass. The PR-0 guard (trg_profiles_zz_column_guard) is untouched.
begin
  if NEW.instagram_username is not distinct from OLD.instagram_username then
    return NEW;
  end if;
  if current_user::text not in ('authenticated', 'anon') then
    return NEW;
  end if;
  if public.challenge_task_ig_handle_locked(NEW.id) then
    raise exception using errcode = 'P0001', message = 'Instagram profilingizni o‘zgartirish uchun admin bilan bog‘laning',
      detail = 'challenge_task_ig_handle_guard: instagram_username locked after an accepted instagram task';
  end if;
  return NEW;
end
$fn$;

drop trigger if exists trg_profiles_zz_ig_handle_lock on public.profiles;
create trigger trg_profiles_zz_ig_handle_lock
  before update of instagram_username on public.profiles
  for each row execute function public.challenge_task_ig_handle_guard();

-- ═══════════════════════════════ 11. Health and the watchdog (§13) ═══════════════════════════════
create or replace function public.challenge_tasks_health(_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- Read-only. Every failure class of the engine has a field here (the prevention-hierarchy backstop). _at exists for
-- the PGlite harness; the watchdog passes now().
declare
  _cfg jsonb := public.challenge_tasks_config();
  _today date := public.challenge_task_local_date(_at);
  _day_start timestamptz := (public.challenge_task_local_date(_at)::timestamp at time zone 'Asia/Tashkent');
  _week_start date := date_trunc('week', _at at time zone 'Asia/Tashkent')::date;
  _hb record;
  _sweep record;
  _courses jsonb;
  _groups jsonb;
  _leak int := 0;
  _drift int := 0;
  _orph int := 0;
  _streak_noxp int := 0;
  _streak_excess int := 0;
  _after_freeze int := 0;
begin
  select a.created_at, a.details into _hb from public.admin_actions a
   where a.action = 'challenge_task_reconciled' order by a.created_at desc limit 1;
  select a.created_at, a.details into _sweep from public.admin_actions a
   where a.action = 'challenge_task_identity_sweep' order by a.created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'course_id', c.course_id,
           'is_task_day', public.challenge_task_is_task_day(c.course_id, _today, _cfg),
           'tomorrow_is_task_day', public.challenge_task_is_task_day(c.course_id, _today + 1, _cfg),
           'task_today', (select jsonb_build_object('id', t.id, 'type', t.type, 'title', t.title) from public.challenge_tasks t
                           where t.course_id = c.course_id and t.task_date = _today and t.status = 'approved'),
           'task_tomorrow', (select jsonb_build_object('id', t.id, 'type', t.type, 'title', t.title) from public.challenge_tasks t
                              where t.course_id = c.course_id and t.task_date = _today + 1 and t.status = 'approved'))), '[]'::jsonb)
    into _courses
    from (select distinct x.course_id from public.challenge_task_topics() x) c;

  select coalesce(jsonb_agg(jsonb_build_object(
           'group_id', g.group_id, 'course_id', g.course_id, 'chat_id', g.chat_id, 'thread_id', g.thread_id, 'is_test', g.is_test,
           'post_today', (select p.state from public.challenge_task_posts p join public.challenge_tasks t on t.id = p.task_id
                           where p.group_id = g.group_id and p.kind = 'task' and t.task_date = _today and t.status = 'approved' limit 1),
           'captures_today', (select count(*) from public.challenge_task_messages m where m.group_id = g.group_id and m.sent_at >= _day_start and m.sent_at < _at + interval '1 minute'),
           'last3_task_days_with_captures', (
             select count(*) from (
               select t.task_date from public.challenge_tasks t
                where t.course_id = g.course_id and t.status = 'approved' and t.task_date < _today
                order by t.task_date desc limit 3) d
              where exists (select 1 from public.challenge_task_messages m
                             where m.group_id = g.group_id
                               and m.sent_at >= (d.task_date::timestamp at time zone 'Asia/Tashkent')
                               and m.sent_at < ((d.task_date + 1)::timestamp at time zone 'Asia/Tashkent'))),
           'bot_status', (select jsonb_build_object('status', a.details->>'new_status', 'at', a.created_at,
                                                    'can_delete_messages', a.details->'can_delete_messages')
                            from public.admin_actions a
                           where a.action = 'challenge_bot_status_changed' and a.details->>'chat' = g.chat_id::text
                           order by a.created_at desc limit 1))), '[]'::jsonb)
    into _groups
    from public.challenge_task_topics() g;

  -- I2 residuals: challenge media / chat / answer and community help / question rows on daily-topic messages
  select count(*)::int into _leak
    from public.xp_events e
   where e.created_at >= _at - interval '24 hours'
     and (
       (e.reason in ('challenge_group_media', 'challenge_chat') and split_part(e.ref_key, ':', 1) in ('ch_img', 'ch_chat')
        and exists (select 1 from public.group_message_events m join public.groups g on g.id = m.group_id
                     where g.daily_task_topic_id is not null
                       and m.telegram_chat_id::text = split_part(e.ref_key, ':', 2)
                       and m.telegram_message_id::text = split_part(e.ref_key, ':', 3)
                       and m.telegram_thread_id = g.daily_task_topic_id))
       or (e.reason = 'challenge_group_media' and split_part(e.ref_key, ':', 1) = 'ch_alb'
           and exists (select 1 from public.webhook_inbox w join public.groups g on g.daily_task_chat_id = w.chat_id
                        where w.chat_id::text = split_part(e.ref_key, ':', 2) and w.update_type = 'message'
                          and w.raw_update->'message'->>'media_group_id' = split_part(e.ref_key, ':', 3)
                          and w.message_thread_id = g.daily_task_topic_id))
       or (e.reason = 'challenge_answer'
           and exists (select 1 from public.challenge_qa_candidates c join public.groups g on g.id = c.group_id
                        where c.xp_ref_key = e.ref_key and g.daily_task_topic_id is not null and c.thread_id = g.daily_task_topic_id))
       or (e.reason in ('community_help', 'community_question')
           and exists (select 1 from public.group_message_events m join public.groups g on g.id = m.group_id
                        where m.profile_id = e.user_id and m.sent_at = e.created_at
                          and g.daily_task_topic_id is not null and m.telegram_thread_id = g.daily_task_topic_id)));

  select count(*)::int into _drift
    from public.challenge_task_submissions s
    join public.challenge_tasks t on t.id = s.task_id
    left join public.xp_events e on e.user_id = s.user_id and e.ref_key = 'ch_task:' || s.task_id::text
   where s.status = 'accepted'
     and ((t.status = 'approved' and e.id is null and public.challenge_task_points_for(t, s.late_days, _cfg) > 0
           and not (t.type = 'instagram' and s.ig_shortcode is null))
          or (t.status <> 'approved' and e.id is not null)
          or (e.id is not null and e.amount <> s.points_awarded));
  select count(*)::int into _orph
    from public.xp_events e
   where e.reason = 'challenge_task'
     and not exists (select 1 from public.challenge_task_submissions s
                      where s.user_id = e.user_id and 'ch_task:' || s.task_id::text = e.ref_key and s.status = 'accepted');
  select count(*)::int into _streak_noxp
    from public.challenge_task_streak_awards a
   where not exists (select 1 from public.xp_events e where e.user_id = a.user_id and e.ref_key = a.xp_ref_key)
     and a.created_at > coalesce((select max(v.created_at) from public.admin_actions v
                                   where v.action = 'challenge_points_voided' and v.target_user_id = a.user_id), '-infinity'::timestamptz);
  -- R2: an award whose claimed days overlap an earlier award's (a day paid twice). Awards at or before the student's
  -- newest void tombstone are out (the void removed their points).
  select count(*)::int into _streak_excess
    from public.challenge_task_streak_awards a
   where a.created_at > coalesce(public.challenge_task_void_at(a.user_id), '-infinity'::timestamptz)
     and exists (select 1 from public.challenge_task_streak_awards b
                  where b.user_id = a.user_id and b.course_id = a.course_id and b.id < a.id
                    and b.created_at > coalesce(public.challenge_task_void_at(b.user_id), '-infinity'::timestamptz)
                    and b.claimed_dates && a.claimed_dates);
  -- C11 / R4: a task or streak award whose ledger created_at sits in a week that was ALREADY frozen when it was
  -- written (either freeze key) -- 0 by construction, so any row is a bug
  select count(*)::int into _after_freeze
    from (select s.xp_created_at as xp_at, s.awarded_at as written_at
            from public.challenge_task_submissions s
           where s.awarded_at >= _at - interval '7 days' and s.xp_created_at is not null and s.points_awarded > 0
          union all
          select e.created_at, a.created_at
            from public.challenge_task_streak_awards a
            join public.xp_events e on e.user_id = a.user_id and e.ref_key = a.xp_ref_key
           where a.created_at >= _at - interval '7 days') w
   where public.challenge_task_week_frozen_at(w.xp_at) < w.written_at;

  return jsonb_build_object(
    'state', jsonb_build_object(
      'enabled', _cfg->'enabled', 'challenge_enabled', _cfg->'challenge_enabled', 'active', _cfg->'active', 'ai', _cfg->'ai',
      'receipts', _cfg->'receipts', 'miniapp', _cfg->'miniapp', 'config_invalid', coalesce(_cfg->'invalid', '[]'::jsonb),
      'window', jsonb_build_object('start', _cfg->'w_start', 'end', _cfg->'w_end'),
      'last_reconcile_at', _hb.created_at, 'last_reconcile', _hb.details,
      'identity_sweep_last', case when _sweep.created_at is not null then jsonb_build_object('at', _sweep.created_at, 'details', _sweep.details) end),
    'today', jsonb_build_object('date', _today, 'courses', _courses),
    'groups', _groups,
    'submissions', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                      from (select s.status, count(*) as n from public.challenge_task_submissions s group by s.status) x),
    'outcomes_24h', (select coalesce(jsonb_object_agg(x.outcome, x.n), '{}'::jsonb)
                       from (select m.outcome, count(*) as n from public.challenge_task_messages m
                              where m.created_at >= _at - interval '24 hours' group by m.outcome) x),
    'retry', jsonb_build_object(
      'pending', (select count(*) from public.challenge_task_retry r where r.outcome in ('error', 'disabled') and r.first_at < _at - interval '20 minutes'),
      'pending_60', (select count(*) from public.challenge_task_retry r where r.outcome in ('error', 'disabled') and r.first_at < _at - interval '60 minutes'),
      'unknown_sender_24h', (select count(distinct r.tg_user_id) from public.challenge_task_retry r
                              where r.outcome = 'unknown_sender' and r.shaped and coalesce(r.message_at, r.first_at) >= _at - interval '24 hours'),
      'unknown_sender_stuck_2h', (select count(distinct r.tg_user_id) from public.challenge_task_retry r
                                   where r.outcome = 'unknown_sender' and r.shaped and r.first_at < _at - interval '2 hours'
                                     and coalesce(r.message_at, r.first_at) >= _at - interval '26 hours')),
    'paused_messages_24h', case when coalesce((_cfg->>'active')::boolean, false) then 0 else
      (select count(*) from public.webhook_inbox w
         join public.challenge_task_topics() t on t.chat_id = w.chat_id and t.thread_id = w.message_thread_id
        where w.update_type = 'message' and w.received_at >= _at - interval '24 hours'
          and not coalesce((w.raw_update->'message'->'from'->>'is_bot')::boolean, false)
          and not exists (select 1 from public.challenge_task_messages m where m.chat_id = w.chat_id and m.message_id = w.message_id)) end,
    'held_24h', (select jsonb_build_object(
                   'no_group', count(distinct a.target_user_id) filter (where a.details->>'reason' = 'no_group'),
                   'out_of_scope', count(distinct a.target_user_id) filter (where a.details->>'reason' = 'sender_out_of_scope'),
                   'inactive', count(distinct a.target_user_id) filter (where a.details->>'reason' = 'inactive'),
                   'today', count(distinct a.target_user_id) filter (where a.created_at >= _day_start))
                   from public.admin_actions a
                  where a.action = 'challenge_task_sender_held' and a.created_at >= _at - interval '24 hours'),
    'username_match_unlinked_24h', (select count(distinct m.user_id) from public.challenge_task_messages m join public.profiles p on p.id = m.user_id
                                     where m.resolved_via = 'username_match' and p.telegram_id is null and m.created_at >= _at - interval '24 hours'),
    'username_match_unlinked_2h_old', (select count(distinct m.user_id) from public.challenge_task_messages m join public.profiles p on p.id = m.user_id
                                        where m.resolved_via = 'username_match' and p.telegram_id is null
                                          and m.created_at < _at - interval '2 hours' and m.created_at >= _at - interval '26 hours'),
    'rate_limited_24h', (select count(*) from public.admin_actions a where a.action = 'telegram_rate_limited' and a.created_at >= _at - interval '24 hours'),
    'capture_failed_24h', (select count(*) from public.admin_actions a where a.action = 'challenge_task_capture_failed' and a.created_at >= _at - interval '24 hours'),
    'receipts_queued_24h', (select count(*) from public.admin_actions a where a.action = 'challenge_task_receipt_queued' and a.created_at >= _at - interval '24 hours'),
    'topic_missing_24h', (select count(*) from public.admin_actions a where a.action = 'challenge_task_topic_missing' and a.created_at >= _at - interval '24 hours'),
    'legacy_swaps_7d', (select count(*) from public.admin_actions a where a.action = 'challenge_task_legacy_swap' and a.created_at >= _at - interval '7 days'),
    'handle_changes_7d', (select count(*) from public.admin_actions a where a.action = 'instagram_handle_changed' and a.created_at >= _at - interval '7 days'),
    'ig_link_unverified_7d', (select count(*) from public.challenge_task_submissions s
                               where s.checked_at >= _at - interval '7 days' and s.check_result->>'link_status' = 'unverified'),
    'fingerprint_unavailable_7d', (select count(*) from public.challenge_task_submissions s
                                    where s.checked_at >= _at - interval '7 days' and s.check_result->>'fingerprint' = 'unavailable'),
    'misplaced_homework_autotag_24h', (select count(*) from public.admin_actions a
                                        where a.action = 'challenge_task_misplaced_homework' and a.created_at >= _at - interval '24 hours'),
    -- R1: a MISSED-day slot created while the same student's other work was inside merge_window_min (only a kind
    -- today's task does not accept can still do that). Informational: nonzero = look at those students' receipts.
    'missed_within_burst_7d', (select count(*) from public.challenge_task_submissions s
                                where s.attributed_via = 'missed' and s.created_at >= _at - interval '7 days'
                                  and exists (select 1 from public.challenge_task_messages m
                                               where m.user_id = s.user_id and m.submission_id is not null and m.submission_id <> s.id
                                                 and m.outcome in ('created', 'appended', 'appended_album', 'adopted')
                                                 and m.sent_at <= s.submitted_at
                                                 and m.sent_at >= s.submitted_at - make_interval(mins => coalesce((_cfg->>'merge_window_min')::int, 5)))),
    'held_checks', (select jsonb_build_object(
                      'ai_off', count(*) filter (where s.hold_reason = 'ai_off'),
                      'ig_waiting_ai', count(*) filter (where s.hold_reason = 'ig_waiting_ai'),
                      'oldest_min', round(extract(epoch from (_at - min(s.last_item_at))) / 60),
                      'closing_week', count(*) filter (where public.challenge_task_local_date(s.submitted_at) >= _week_start))
                      from public.challenge_task_submissions s where s.status = 'checking' and s.hold_reason is not null),
    'checks', (select jsonb_build_object(
                 'queue', count(*), 'oldest_min', round(extract(epoch from (_at - min(coalesce(s.checking_since, s.last_item_at)))) / 60),
                 'stuck_attempts', count(*) filter (where s.check_attempts >= 5),
                 'closing_week', count(*) filter (where public.challenge_task_local_date(s.submitted_at) >= _week_start))
                 from public.challenge_task_submissions s where s.status = 'checking' and s.hold_reason is null),
    'ai_24h', (select jsonb_build_object('calls', count(*), 'errors', count(*) filter (where c.status <> 'ok'),
                                         'cost_usd', coalesce(sum(c.cost_usd), 0))
                 from public.challenge_task_ai_calls c where c.created_at >= _at - interval '24 hours'),
    'receipts', jsonb_build_object(
      'pending', (select count(*) from public.challenge_task_submissions s where s.receipt_state in ('pending', 'sending') and s.receipt_version > s.receipt_sent_version),
      'failed', (select count(*) from public.challenge_task_submissions s where s.receipt_state = 'failed')),
    'miniapp', (select jsonb_build_object('posted_stuck', count(*) filter (where c.state = 'posted' and c.updated_at < _at - interval '30 minutes'),
                                          'failed_24h', count(*) filter (where c.state = 'failed' and c.updated_at >= _at - interval '24 hours'))
                  from public.challenge_task_submit_claims c),
    'outbox', (select jsonb_build_object('pending', count(*) filter (where o.state in ('pending', 'sending')),
                                         'failed', count(*) filter (where o.state = 'failed'))
                 from public.challenge_task_outbox o),
    'invariants', jsonb_build_object(
      'ledger_drift', _drift + _orph,
      'streak_awards_without_xp', _streak_noxp,
      'streak_awards_excess', _streak_excess,
      'topic_points_leak_24h', _leak,
      'awards_after_freeze_7d', _after_freeze,
      'live_duplicates', (select count(*) from (select 1 from public.challenge_task_submissions s
                                                 where s.status in ('needs_more', 'checking', 'accepted')
                                                 group by s.user_id, s.task_id having count(*) > 1) d)),
    'at', _at);
end
$fn$;

create or replace function public.challenge_tasks_watchdog(_at timestamptz default now())
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- §13.2, cron 'challenge-tasks-watchdog' at :47. Paused -> stamps checked_at and a report row ONLY (inert; the
-- out-of-band verifier sees a live state row). Active -> alarms (I10: calendar alarms only on TASK days), each
-- DM'd at most once per 24 h; a recovery DM only after an alert actually went out. DMs: up to 3 admins through
-- ops_net_post with a Content-Type header. Every run writes 'challenge_tasks_watchdog_run'.
-- Kill-switch runbook: unscheduling this job must also delete app_settings 'challenge_tasks_watchdog_state'.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _h jsonb;
  _state jsonb;
  _alarms text[] := '{}';
  _msgs text[] := '{}';
  _lt time := (_at at time zone 'Asia/Tashkent')::time;
  _today date := public.challenge_task_local_date(_at);
  _post time := coalesce((_cfg->>'post_time')::time, time '09:00');
  _live time := coalesce((_cfg->>'liveness_check_time')::time, time '14:00');
  _c jsonb;
  _g jsonb;
  _sent_map jsonb;
  _now_ms bigint := (extract(epoch from _at) * 1000)::bigint;
  _new text[] := '{}';
  _send boolean := false;
  _recover boolean := false;
  _notified boolean;
  _dm int := 0;
  _tok text;
  _admin record;
  _msg text;
  _report jsonb;
  _k text;
  _n int;
begin
  select value into _state from public.app_settings where key = 'challenge_tasks_watchdog_state';
  _state := coalesce(_state, '{}'::jsonb);
  if not coalesce((_cfg->>'active')::boolean, false) then
    _report := jsonb_build_object('state', 'inactive', 'enabled', _cfg->'enabled', 'challenge_enabled', _cfg->'challenge_enabled', 'at', now());
    insert into public.admin_actions (actor_user_id, action, details) values (null, 'challenge_tasks_watchdog_run', _report);
    insert into public.app_settings (key, value)
    values ('challenge_tasks_watchdog_state', _state || jsonb_build_object('checked_at', now(), 'last_state', 'inactive'))
    on conflict (key) do update set value = excluded.value, updated_at = now();
    return _report;
  end if;

  begin
    _h := public.challenge_tasks_health(_at);
  exception when others then
    _h := null;
    _alarms := _alarms || 'health_crashed'::text;
    _msgs := _msgs || ('challenge_tasks_health() xato: ' || left(sqlerrm, 150));
  end;

  if _h is not null then
    -- reconciler liveness
    if (_h#>>'{state,last_reconcile_at}') is null or (_h#>>'{state,last_reconcile_at}')::timestamptz < _at - interval '40 minutes' then
      _alarms := _alarms || 'reconciler_silent'::text;
      _msgs := _msgs || 'Kunlik vazifa hisoblagichi (reconcile_challenge_tasks) 40 daqiqadan beri ishlamadi.'::text;
    elsif coalesce(_h#>'{state,last_reconcile,section_errors}', '{}'::jsonb) <> '{}'::jsonb then
      _alarms := _alarms || 'reconciler_errors'::text;
      _msgs := _msgs || ('Hisoblagichda xato: ' || left((_h#>'{state,last_reconcile,section_errors}')::text, 200));
    end if;
    -- calendar (task days only, G6 / I10)
    for _c in select value from jsonb_array_elements(coalesce(_h#>'{today,courses}', '[]'::jsonb)) loop
      if (_c->>'is_task_day')::boolean and jsonb_typeof(_c->'task_today') is distinct from 'object' and _lt >= _post + interval '5 minutes' then
        _alarms := _alarms || 'no_task_today'::text;
        _msgs := _msgs || ('Bugun (' || _today || ') uchun tasdiqlangan kunlik vazifa yo‘q.');
      end if;
      if (_c->>'tomorrow_is_task_day')::boolean and jsonb_typeof(_c->'task_tomorrow') is distinct from 'object' and _lt >= time '18:00' then
        _alarms := _alarms || 'no_task_tomorrow'::text;
        _msgs := _msgs || ('Ertaga (' || (_today + 1) || ') uchun tasdiqlangan vazifa yo‘q.');
      end if;
    end loop;
    for _g in select value from jsonb_array_elements(coalesce(_h->'groups', '[]'::jsonb)) loop
      _c := (select value from jsonb_array_elements(coalesce(_h#>'{today,courses}', '[]'::jsonb)) x where x.value->>'course_id' = _g->>'course_id' limit 1);
      if jsonb_typeof(_c->'task_today') = 'object' and coalesce((_cfg->>'post')::boolean, true)
         and _lt >= _post + interval '30 minutes' and coalesce(_g->>'post_today', '') not in ('sent', 'sent_via_sql', 'manual') then
        _alarms := _alarms || 'post_missing'::text;
        _msgs := _msgs || ('Bugungi vazifa guruhga e’lon qilinmagan (chat ' || (_g->>'chat_id') || ').');
      end if;
      if jsonb_typeof(_c->'task_today') = 'object' and _lt >= _live and coalesce(_g->>'post_today', '') in ('sent', 'sent_via_sql', 'manual')
         and coalesce((_g->>'captures_today')::int, 0) = 0 and coalesce((_g->>'last3_task_days_with_captures')::int, 0) >= 2 then
        _alarms := _alarms || 'capture_liveness'::text;
        _msgs := _msgs || ('Bugun ' || _live || ' gacha guruhdan birorta ham topshiriq kelmadi (chat ' || (_g->>'chat_id') || ') — bot huquqlarini tekshiring.');
      end if;
      if _g#>>'{bot_status,status}' is not null and _g#>>'{bot_status,status}' <> 'administrator' then
        _alarms := _alarms || 'bot_status'::text;
        _msgs := _msgs || ('Bot guruhda admin emas (chat ' || (_g->>'chat_id') || ': ' || (_g#>>'{bot_status,status}') || ').');
      end if;
    end loop;
    if coalesce((_h#>>'{held_24h,today}')::int, 0) >= 1 then
      _alarms := _alarms || 'held_senders'::text;
      _msgs := _msgs || ((_h#>>'{held_24h,today}') || ' ta a’zoning kunlik vazifasi hisoblanmayapti (profil guruhga biriktirilmagan / faol emas).');
    end if;
    if coalesce((_h#>>'{retry,pending_60}')::int, 0) >= 5 then
      _alarms := _alarms || 'retry_pending'::text;
      _msgs := _msgs || ((_h#>>'{retry,pending_60}') || ' ta xabar 60 daqiqadan beri qayta ishlanmoqda (xato).');
    end if;
    if coalesce((_h#>>'{retry,unknown_sender_stuck_2h}')::int, 0) >= 3 then
      _alarms := _alarms || 'unknown_senders'::text;
      _msgs := _msgs || ((_h#>>'{retry,unknown_sender_stuck_2h}') || ' ta noma’lum yuboruvchining ishi 2 soatdan beri bog‘lanmagan.');
    end if;
    if coalesce((_h->>'username_match_unlinked_2h_old')::int, 0) > 0 then
      _alarms := _alarms || 'username_unlinked'::text;
      _msgs := _msgs || ((_h->>'username_match_unlinked_2h_old') || ' ta o‘quvchi username orqali topildi, lekin Telegram ID 2 soatda bog‘lanmadi.');
    end if;
    if coalesce((_h#>>'{invariants,awards_after_freeze_7d}')::int, 0) > 0 then
      _alarms := _alarms || 'awards_after_freeze'::text;
      _msgs := _msgs || ((_h#>>'{invariants,awards_after_freeze_7d}') || ' ta ball muzlatilgan haftaga yozildi.');
    end if;
    if extract(isodow from _today) = 7 and _lt >= time '20:00'
       and coalesce((_h#>>'{held_checks,closing_week}')::int, 0) + coalesce((_h#>>'{checks,closing_week}')::int, 0) > 0 then
      _alarms := _alarms || 'held_checks_closing_week'::text;
      _msgs := _msgs || ('Hafta yopilmoqda: ' || (coalesce((_h#>>'{held_checks,closing_week}')::int, 0) + coalesce((_h#>>'{checks,closing_week}')::int, 0))
                         || ' ta topshiriq hali tekshirilmagan (dushanba 09:10 muzlatishdan oldin).');
    end if;
    if coalesce((_h->>'topic_missing_24h')::int, 0) > 0 then
      _alarms := _alarms || 'topic_missing'::text;
      _msgs := _msgs || ('Kunlik vazifalar topigi topilmadi / yopilgan (' || (_h->>'topic_missing_24h') || ' marta).');
    end if;
    if coalesce((_h->>'misplaced_homework_autotag_24h')::int, 0) >= 5 then
      _alarms := _alarms || 'misplaced_homework'::text;
      _msgs := _msgs || ((_h->>'misplaced_homework_autotag_24h') || ' ta kunlik ish uy vazifasi topigiga yuborilgan.');
    end if;
    if coalesce((_h#>>'{invariants,ledger_drift}')::int, 0) > 0 or coalesce((_h#>>'{invariants,streak_awards_without_xp}')::int, 0) > 0
       or coalesce((_h#>>'{invariants,streak_awards_excess}')::int, 0) > 0
       or coalesce((_h#>>'{invariants,topic_points_leak_24h}')::int, 0) > 0 or coalesce((_h#>>'{invariants,live_duplicates}')::int, 0) > 0 then
      _alarms := _alarms || 'invariant'::text;
      _msgs := _msgs || ('Invariant buzildi: ' || left((_h->'invariants')::text, 200));
    end if;
    if jsonb_array_length(coalesce(_h#>'{state,config_invalid}', '[]'::jsonb)) > 0 then
      _alarms := _alarms || 'config_invalid'::text;
      _msgs := _msgs || ('platform_settings.challenge_tasks noto‘g‘ri: ' || (_h#>'{state,config_invalid}')::text);
    end if;
    if coalesce((_cfg->>'ai')::boolean, false)
       and (coalesce((_h#>>'{checks,oldest_min}')::numeric, 0) > 90 or coalesce((_h#>>'{checks,stuck_attempts}')::int, 0) > 0) then
      _alarms := _alarms || 'checks_stuck'::text;
      _msgs := _msgs || ('AI tekshiruv navbati turib qoldi (eng eskisi ' || coalesce(_h#>>'{checks,oldest_min}', '?') || ' daqiqa).');
    end if;
  end if;

  select coalesce(array_agg(distinct a), '{}') into _alarms from unnest(_alarms) a;
  _sent_map := case when jsonb_typeof(_state->'sent') = 'object' then _state->'sent' else '{}'::jsonb end;
  _notified := coalesce((_state->>'notified')::boolean, false);
  foreach _k in array _alarms loop
    if not (_sent_map ? _k) or _now_ms - (_sent_map->>_k)::bigint > 86400000 then
      _new := _new || _k;
    end if;
  end loop;
  _send := cardinality(_new) > 0;
  _recover := cardinality(_alarms) = 0 and _notified;

  if _send or _recover then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recover
        then '✅ Kunlik vazifalar (Challenge 6.0) normallashdi.'
        else '⚠️ Kunlik vazifalar (Challenge 6.0): ' || array_to_string(_msgs, ' | ')
             || E'\nTafsilot: admin_actions → challenge_tasks_watchdog_run' end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
         where p.telegram_id is not null
         limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3500)),
            p_headers := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose := 'challenge-tasks-watchdog',
            p_timeout_ms := 8000);
          _dm := _dm + 1;
        exception when others then null;
        end;
      end loop;
    end if;
    if _dm > 0 and _send then
      foreach _k in array _new loop
        _sent_map := _sent_map || jsonb_build_object(_k, _now_ms);
      end loop;
      _notified := true;
    end if;
    if _dm > 0 and _recover then
      _notified := false;
      _sent_map := '{}'::jsonb;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('challenge_tasks_watchdog_state', jsonb_build_object(
    'alerting', cardinality(_alarms) > 0, 'notified', _notified, 'alarms', to_jsonb(_alarms), 'sent', _sent_map,
    'last_state', case when cardinality(_alarms) > 0 then 'alarm' else 'ok' end, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  _report := jsonb_build_object('state', case when cardinality(_alarms) > 0 then 'alarm' else 'ok' end,
    'alarms', to_jsonb(_alarms), 'new_alarms', to_jsonb(_new), 'messages', to_jsonb(_msgs), 'dm_sent', _dm, 'recovered', _recover and _dm > 0,
    'health', _h, 'at', now());
  insert into public.admin_actions (actor_user_id, action, details) values (null, 'challenge_tasks_watchdog_run', _report);
  return _report;
end
$fn$;

-- ═══════════════════════════════ 12. Pinned rewrite: xp_award_integrity_watchdog labels (G31, §6.14d) ═══════════════════════════════
-- The daily XP integrity watchdog lists reasons it cannot verify from a source table. challenge_chat and
-- challenge_answer (#218) and the two task reasons are missing, so they would show up nowhere; the task reasons are
-- verified by challenge_tasks_health().invariants.ledger_drift instead. ONE anchor, asserted to occur exactly once.
do $$
declare
  _pin constant text := '0a7c5bae4e1ff1d6e8eb667c39af0335';       -- live md5(prosrc), re-read 2026-09-30
  _new_pin constant text := '71500fc16be28f1825746550a1d32992';  -- the rewritten body (PGlite harness + an independent recompute)
  _old1 constant text := E'      ''challenge_group_media'',''challenge_question'',''challenge_instagram''),\n';
  _new1 constant text :=
       E'      ''challenge_group_media'',''challenge_question'',''challenge_instagram'',\n'
    || E'      -- 20260930150020 (Daily Tasks PR-3): the task reasons are verified by challenge_tasks_health() ledger_drift\n'
    || E'      ''challenge_chat'',''challenge_answer'',''challenge_task'',''challenge_task_streak''),\n';
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _fn := to_regprocedure('public.xp_award_integrity_watchdog()');
  if _fn is null then
    raise exception 'ABORT: public.xp_award_integrity_watchdog() not found';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef from pg_proc where oid = _fn;
  if position('''challenge_task_streak''' in _src) > 0 then      -- replay: the marker exists only after this rewrite
    raise notice 'xp_award_integrity_watchdog already lists the daily-task reasons -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: xp_award_integrity_watchdog changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;
  _def := pg_get_functiondef(_fn);
  _n := (length(_def) - length(replace(_def, _old1, ''))) / length(_old1);
  if _n <> 1 then
    raise exception 'ABORT: xp_award_integrity_watchdog anchor matched % times (want exactly 1)', _n;
  end if;
  _new := replace(_def, _old1, _new1);
  execute _new;
  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: xp_award_integrity_watchdog -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: xp_award_integrity_watchdog -- owner, ACL or SECURITY DEFINER changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: xp_award_integrity_watchdog -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 13. Grants: service_role only, except the student / admin RPCs ═══════════════════════════════
-- anon and authenticated inherit PUBLIC, so every revoke names PUBLIC first. Tables: RLS on, no client grant at all.
alter table public.challenge_task_submissions enable row level security;
revoke all on table public.challenge_task_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_submissions to service_role;
alter table public.challenge_task_messages enable row level security;
revoke all on table public.challenge_task_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_messages to service_role;
alter table public.challenge_ig_posts enable row level security;
revoke all on table public.challenge_ig_posts from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_ig_posts to service_role;
alter table public.challenge_task_streak_awards enable row level security;
revoke all on table public.challenge_task_streak_awards from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_streak_awards to service_role;
alter table public.challenge_task_outbox enable row level security;
revoke all on table public.challenge_task_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_outbox to service_role;
alter table public.challenge_task_submit_claims enable row level security;
revoke all on table public.challenge_task_submit_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_submit_claims to service_role;
alter table public.challenge_task_ai_calls enable row level security;
revoke all on table public.challenge_task_ai_calls from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_ai_calls to service_role;
alter table public.challenge_task_retry enable row level security;
revoke all on table public.challenge_task_retry from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_task_retry to service_role;
do $$
declare
  _t text;
  _s text;
begin
  -- identity columns need no sequence privilege to INSERT; nobody but service_role touches the sequences directly
  foreach _t in array array['challenge_task_submissions', 'challenge_task_messages', 'challenge_task_streak_awards',
                            'challenge_task_outbox', 'challenge_task_ai_calls'] loop
    _s := pg_get_serial_sequence('public.' || _t, 'id');
    execute format('revoke all on sequence %s from public, anon, authenticated', _s);
    execute format('grant usage, select on sequence %s to service_role', _s);
  end loop;
end $$;
revoke execute on function public.challenge_task_accepts_kind(text) from public, anon, authenticated;
grant execute on function public.challenge_task_accepts_kind(text) to service_role;
revoke execute on function public.challenge_task_classify(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_classify(jsonb) to service_role;
revoke execute on function public.challenge_task_requires_eval(text, jsonb, text[], jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.challenge_task_requires_eval(text, jsonb, text[], jsonb, integer, integer) to service_role;
revoke execute on function public.challenge_task_can_create(jsonb, text[], text[]) from public, anon, authenticated;
grant execute on function public.challenge_task_can_create(jsonb, text[], text[]) to service_role;
revoke execute on function public.challenge_task_supplies(jsonb, text[], text[]) from public, anon, authenticated;
grant execute on function public.challenge_task_supplies(jsonb, text[], text[]) to service_role;
revoke execute on function public.challenge_task_comment_reason(jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.challenge_task_comment_reason(jsonb, text, integer, integer) to service_role;
revoke execute on function public.challenge_task_edit_distance(text, text) from public, anon, authenticated;
grant execute on function public.challenge_task_edit_distance(text, text) to service_role;
revoke execute on function public.challenge_task_dhash_distance(text, text) from public, anon, authenticated;
grant execute on function public.challenge_task_dhash_distance(text, text) to service_role;
revoke execute on function public.challenge_task_norm_handle(text) from public, anon, authenticated;
grant execute on function public.challenge_task_norm_handle(text) to service_role;
revoke execute on function public.challenge_task_verdict_valid(text, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_verdict_valid(text, jsonb) to service_role;
revoke execute on function public.challenge_tasks_config() from public, anon, authenticated;
grant execute on function public.challenge_tasks_config() to service_role;
revoke execute on function public.challenge_tasks_note_invalid(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_tasks_note_invalid(jsonb) to service_role;
revoke execute on function public.challenge_task_local_date(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_local_date(timestamptz) to service_role;
revoke execute on function public.challenge_task_open_at(public.challenge_tasks, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_open_at(public.challenge_tasks, uuid, jsonb) to service_role;
revoke execute on function public.challenge_task_close_at(public.challenge_tasks, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_close_at(public.challenge_tasks, jsonb) to service_role;
revoke execute on function public.challenge_task_void_at(uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_void_at(uuid) to service_role;
revoke execute on function public.challenge_task_week_frozen_at(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_week_frozen_at(timestamptz) to service_role;
revoke execute on function public.challenge_task_award_ts(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_award_ts(timestamptz) to service_role;
revoke execute on function public.challenge_task_rejected_count(uuid, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_rejected_count(uuid, bigint) to service_role;
revoke execute on function public.challenge_task_is_task_day(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_is_task_day(uuid, date, jsonb) to service_role;
revoke execute on function public.challenge_task_dm_eligible(uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_dm_eligible(uuid) to service_role;
revoke execute on function public.challenge_task_day_no(public.challenge_tasks) from public, anon, authenticated;
grant execute on function public.challenge_task_day_no(public.challenge_tasks) to service_role;
revoke execute on function public.challenge_task_points_for(public.challenge_tasks, integer, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_points_for(public.challenge_tasks, integer, jsonb) to service_role;
revoke execute on function public.challenge_task_rebuild_user_xp(uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_rebuild_user_xp(uuid) to service_role;
revoke execute on function public.challenge_task_evaluate(bigint, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.challenge_task_evaluate(bigint, jsonb, boolean) to service_role;
revoke execute on function public.challenge_task_streak_current(uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_streak_current(uuid, uuid) to service_role;
revoke execute on function public.challenge_task_streak_recompute(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_streak_recompute(uuid, uuid, jsonb) to service_role;
revoke execute on function public.challenge_task_settle_ut(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_settle_ut(uuid, bigint, jsonb) to service_role;
revoke execute on function public.challenge_task_legacy_swap(uuid, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.challenge_task_legacy_swap(uuid, bigint, bigint, text) to service_role;
revoke execute on function public.challenge_task_reply_kind(bigint, jsonb, uuid, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_reply_kind(bigint, jsonb, uuid, bigint) to service_role;
revoke execute on function public.challenge_task_payload(bigint, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_payload(bigint, text, text, jsonb, jsonb) to service_role;
revoke execute on function public.challenge_task_note_once(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_note_once(text, uuid, jsonb) to service_role;
revoke execute on function public.challenge_task_capture(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_capture(jsonb, text, jsonb) to service_role;
revoke execute on function public.challenge_task_item_edited(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_item_edited(jsonb) to service_role;
revoke execute on function public.challenge_task_prepare_miniapp(uuid, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_prepare_miniapp(uuid, bigint) to service_role;
revoke execute on function public.challenge_task_submit_claim(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_submit_claim(uuid, text, bigint) to service_role;
revoke execute on function public.challenge_task_submit_record(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.challenge_task_submit_record(uuid, text, jsonb, text) to service_role;
revoke execute on function public.challenge_task_capture_miniapp(uuid, bigint, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_capture_miniapp(uuid, bigint, text, timestamptz, jsonb) to service_role;
revoke execute on function public.challenge_task_move_core(bigint, bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.challenge_task_move_core(bigint, bigint, uuid, text) to service_role;
revoke execute on function public.challenge_task_withdraw_core(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.challenge_task_withdraw_core(bigint, uuid, text) to service_role;
revoke execute on function public.challenge_task_restore_core(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.challenge_task_restore_core(bigint, uuid, text) to service_role;
revoke execute on function public.challenge_task_tg_actor(bigint, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_tg_actor(bigint, bigint) to service_role;
revoke execute on function public.challenge_task_move_by_tg(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_move_by_tg(bigint, bigint, bigint) to service_role;
revoke execute on function public.challenge_task_withdraw_by_tg(bigint, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_withdraw_by_tg(bigint, bigint) to service_role;
revoke execute on function public.challenge_task_restore_by_tg(bigint, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_restore_by_tg(bigint, bigint) to service_role;
revoke execute on function public.my_challenge_task_move(bigint, bigint) from public, anon, authenticated;
grant execute on function public.my_challenge_task_move(bigint, bigint) to authenticated, service_role;
revoke execute on function public.my_challenge_task_withdraw(bigint) from public, anon, authenticated;
grant execute on function public.my_challenge_task_withdraw(bigint) to authenticated, service_role;
revoke execute on function public.my_challenge_task_restore(bigint) from public, anon, authenticated;
grant execute on function public.my_challenge_task_restore(bigint) to authenticated, service_role;
revoke execute on function public.my_challenge_tasks() from public, anon, authenticated;
grant execute on function public.my_challenge_tasks() to authenticated, service_role;
revoke execute on function public.my_telegram_write_access_granted() from public, anon, authenticated;
grant execute on function public.my_telegram_write_access_granted() to authenticated, service_role;
revoke execute on function public.challenge_task_card(bigint, bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_card(bigint, bigint) to service_role;
revoke execute on function public.admin_challenge_task_results(bigint) from public, anon, authenticated;
grant execute on function public.admin_challenge_task_results(bigint) to authenticated, service_role;
revoke execute on function public.admin_challenge_task_override(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.admin_challenge_task_override(bigint, text, jsonb) to authenticated, service_role;
revoke execute on function public.challenge_task_check_claim(integer) from public, anon, authenticated;
grant execute on function public.challenge_task_check_claim(integer) to service_role;
revoke execute on function public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb) to service_role;
revoke execute on function public.challenge_task_receipt_claim(integer) from public, anon, authenticated;
grant execute on function public.challenge_task_receipt_claim(integer) to service_role;
revoke execute on function public.challenge_task_receipt_record(bigint, integer, bigint, bigint, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_receipt_record(bigint, integer, bigint, bigint, boolean, text, uuid) to service_role;
revoke execute on function public.challenge_task_post_claim(integer) from public, anon, authenticated;
grant execute on function public.challenge_task_post_claim(integer) to service_role;
revoke execute on function public.challenge_task_post_record(bigint, uuid, text, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.challenge_task_post_record(bigint, uuid, text, uuid, bigint, text) to service_role;
revoke execute on function public.challenge_task_outbox_claim(integer) from public, anon, authenticated;
grant execute on function public.challenge_task_outbox_claim(integer) to service_role;
revoke execute on function public.challenge_task_outbox_record(bigint, uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.challenge_task_outbox_record(bigint, uuid, boolean, text, boolean) to service_role;
revoke execute on function public.challenge_task_identity_pending(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_task_identity_pending(integer, timestamptz) to service_role;
revoke execute on function public.challenge_task_reassign_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_reassign_user(uuid, uuid) to service_role;
revoke execute on function public.challenge_task_note_retry(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_note_retry(jsonb, jsonb) to service_role;
revoke execute on function public.reconcile_challenge_tasks(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_challenge_tasks(timestamptz, timestamptz) to service_role;
revoke execute on function public.challenge_tasks_backfill(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_tasks_backfill(timestamptz, timestamptz) to service_role;
revoke execute on function public.challenge_tasks_lock() from public, anon, authenticated;
revoke execute on function public.challenge_task_ig_handle_locked(uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_ig_handle_locked(uuid) to authenticated, service_role;
revoke execute on function public.challenge_task_ig_handle_guard() from public, anon, authenticated;
revoke execute on function public.challenge_tasks_health(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_tasks_health(timestamptz) to service_role;
revoke execute on function public.challenge_tasks_watchdog(timestamptz) from public, anon, authenticated;
grant execute on function public.challenge_tasks_watchdog(timestamptz) to service_role;

-- ═══════════════════════════════ 14. Cron (inert while paused: a heartbeat / a state stamp only) ═══════════════════════════════
-- 4-59/10 and :47 are free minutes (F14). Neither job posts, sends or calls anything while challenge_tasks.enabled
-- is false; the watchdog DMs admins only when active and alarmed.
do $$
declare _j record;
begin
  for _j in select jobid from cron.job where jobname in ('challenge-tasks-reconcile', 'challenge-tasks-watchdog') loop
    perform cron.unschedule(_j.jobid);
  end loop;
end $$;
select cron.schedule('challenge-tasks-reconcile', '4-59/10 * * * *', $c$ select public.reconcile_challenge_tasks() $c$);
select cron.schedule('challenge-tasks-watchdog', '47 * * * *', $c$ select public.challenge_tasks_watchdog() $c$);

-- ═══════════════════════════════ 15. Self-test (NON-mutating: pure / IMMUTABLE functions, catalog reads, the config parse) ═══════════════════════════════
-- Never calls capture, settle, reconcile, the watchdog, backfill, a claim or reassign (§6.15).
do $$
declare
  _bad text[] := '{}';
  _c jsonb;
  _r record;
  _f text;
  _thread_msg jsonb := '{"message_id": 50, "message_thread_id": 144, "date": 1790000000, "chat": {"id": -1004440955972},
                         "from": {"id": 1001, "is_bot": false}, "text": "Bugungi vazifa bo''yicha fikrlarim shunday",
                         "reply_to_message": {"message_id": 144, "forum_topic_created": {"name": "KUNLIK VAZIFALAR"}}}';
  _shot constant jsonb := '[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}]';
begin
  -- classify
  _c := public.challenge_task_classify('{"message_id":1,"date":1790000000,"from":{"id":7},"photo":[{"file_unique_id":"s1"},{"file_unique_id":"b1"}],"caption":"Mana mening bugungi ishim, ko''ring"}');
  if not (_c->'kinds' @> '["photo","text"]') or (_c->>'text_len')::int <> 34 or _c->'file_ids' <> '["b1"]' or not (_c->>'media')::boolean then
    _bad := _bad || ('classify_photo:' || _c::text);
  end if;
  if public.challenge_task_classify('{"document":{"mime_type":"image/png","file_unique_id":"d1"}}')->'kinds' <> '["image_doc"]'
     or public.challenge_task_classify('{"document":{"mime_type":"video/mp4","file_unique_id":"d2"}}')->'kinds' <> '["video_doc"]'
     or public.challenge_task_classify('{"document":{"mime_type":"application/pdf","file_unique_id":"d3","thumbnail":{}}}')->'kinds' <> '["document"]'
     or not (public.challenge_task_classify('{"document":{"mime_type":"application/pdf","file_unique_id":"d3","thumbnail":{}}}')->>'has_thumb')::boolean then
    _bad := _bad || 'classify_document'::text;
  end if;
  _c := public.challenge_task_classify('{"text":"https://www.instagram.com/p/ABCdef123/?igsh=xyz"}');
  if _c->>'shortcode' <> 'ABCdef123' or not (_c->'kinds' @> '["link","ig_link"]') or (_c->>'text_len')::int <> 0 then
    _bad := _bad || ('classify_ig:' || _c::text);
  end if;
  _c := public.challenge_task_classify('{"text":"https://www.instagram.com/share/p/BXyz123/"}');
  if not (_c->>'ig_share')::boolean or _c->>'shortcode' is not null then _bad := _bad || 'classify_ig_share'::text; end if;
  if (public.challenge_task_classify(_thread_msg)->>'is_real_reply')::boolean
     or not (public.challenge_task_classify(jsonb_set(_thread_msg, '{reply_to_message}', '{"message_id": 49, "from": {"id": 1002}}'))->>'is_real_reply')::boolean then
    _bad := _bad || 'classify_topic_reply_farm'::text;
  end if;
  if public.challenge_task_classify('{"sticker":{"file_unique_id":"x"}}')->'kinds' <> '[]'
     or public.challenge_task_classify('{"animation":{},"document":{"mime_type":"video/mp4"}}')->'kinds' <> '[]' then
    _bad := _bad || 'classify_ignored'::text;
  end if;
  if not (public.challenge_task_classify('{"from":{"id":7},"forward_origin":{"type":"user","sender_user":{"id":8}},"text":"x"}')->>'forward_other')::boolean
     or (public.challenge_task_classify('{"from":{"id":7},"forward_origin":{"type":"user","sender_user":{"id":7}},"text":"x"}')->>'forward_other')::boolean then
    _bad := _bad || 'classify_forward'::text;
  end if;
  if not (public.challenge_task_classify('{"text":"Qachongacha yuborish kerak?"}')->>'question')::boolean
     or not (public.challenge_task_classify('{"text":"Nima qilish kerak"}')->>'question')::boolean
     or (public.challenge_task_classify('{"text":"Bugun men ChatGPT bilan uchta rasm yaratdim va o''rgandim"}')->>'question')::boolean then
    _bad := _bad || 'classify_question'::text;
  end if;
  if (public.challenge_task_classify('{"voice":{"duration":12,"file_unique_id":"v1"}}')->>'duration')::int <> 12 then
    _bad := _bad || 'classify_voice'::text;
  end if;

  -- requires_eval / can_create / supplies
  if not (public.challenge_task_requires_eval('general', _shot, '{text,photo,document}',
            '[{"kinds":["photo","text"],"text_len":25}]', 20, 3)->>'complete')::boolean
     or public.challenge_task_requires_eval('general', _shot, '{text,photo,document}', '[{"kinds":["photo"],"text_len":0}]', 20, 3)->'missing' <> '["text"]'
     or public.challenge_task_requires_eval('general', _shot, '{text,photo,document}', '[{"kinds":["text"],"text_len":40}]', 20, 3)->'missing' <> '["screenshot"]'
     or public.challenge_task_requires_eval('general', '[{"any":["voice","video_note","audio"],"min":1,"label":"voice"}]', '{voice}',
            '[{"kinds":["voice"],"duration":5}]', 20, 20)->'missing' <> '["voice"]'
     or not (public.challenge_task_requires_eval('general', '[]', '{text,photo}', '[{"kinds":["photo"]}]', 20, 3)->>'complete')::boolean
     or (public.challenge_task_requires_eval('general', _shot, '{text,photo}', '[{"kinds":["photo","text"],"text_len":25}]', 20, 3)->>'ai_visible') <> 'true'
     or not (public.challenge_task_requires_eval('general', _shot, '{text,photo}', '[{"kinds":["photo","text"],"text_len":25}]', 20, 3)->>'media_met')::boolean
     or (public.challenge_task_requires_eval('general', '[{"any":["text"],"min":1,"label":"text"}]', '{text,photo}',
            '[{"kinds":["photo","text"],"text_len":25}]', 20, 3)->>'media_met')::boolean then
    _bad := _bad || 'requires_eval'::text;
  end if;
  if public.challenge_task_can_create(_shot, '{text,photo,document}', '{text}')
     or not public.challenge_task_can_create(_shot, '{text,photo,document}', '{photo}')
     or not public.challenge_task_can_create('[{"any":["text"],"min":1,"label":"text"}]', '{text}', '{text}')
     or not public.challenge_task_can_create('[]', '{text,photo}', '{text}')
     or public.challenge_task_can_create('[]', '{photo}', '{text}') then
    _bad := _bad || 'can_create'::text;
  end if;
  if not public.challenge_task_supplies(_shot, '{text}', '{text}') or public.challenge_task_supplies(_shot, '{text}', '{photo}') then
    _bad := _bad || 'supplies'::text;
  end if;

  -- the comment rule (C18)
  if public.challenge_task_comment_reason('{"kinds":["text"],"text_len":40}', 'classmate', 20, 3) is distinct from 'reply_classmate'
     or public.challenge_task_comment_reason('{"kinds":["text"],"text_len":40}', 'classmate_bot_msg', 20, 3) is distinct from 'reply_classmate'
     or public.challenge_task_comment_reason('{"kinds":["photo","text"],"text_len":40}', 'classmate', 20, 3) is not null
     or public.challenge_task_comment_reason('{"kinds":["text"],"text_len":40}', 'staff_or_anon', 20, 3) is not null
     or public.challenge_task_comment_reason('{"kinds":["text","link","ig_link"],"text_len":40,"ig_link":true}', 'classmate', 20, 3) is not null
     or public.challenge_task_comment_reason('{"kinds":["text"],"text_len":10,"question":true}', 'none', 20, 3) is distinct from 'question'
     or public.challenge_task_comment_reason('{"kinds":["text"],"text_len":10}', 'none', 20, 3) is distinct from 'short_text'
     or public.challenge_task_comment_reason('{"kinds":["voice"],"duration":2}', 'none', 20, 3) is distinct from 'short_voice'
     or public.challenge_task_comment_reason('{"kinds":["text"],"text_len":40}', 'none', 20, 3) is not null then
    _bad := _bad || 'comment_rule'::text;
  end if;

  -- small pure helpers
  if public.challenge_task_edit_distance('aicreators', 'aicreator') <> 1 or public.challenge_task_edit_distance('Abc', 'abc') <> 0
     or public.challenge_task_edit_distance('', 'abc') <> 3 or public.challenge_task_edit_distance('kitten', 'sitting') <> 3 then
    _bad := _bad || 'edit_distance'::text;
  end if;
  if public.challenge_task_dhash_distance('ffffffffffffffff', 'fffffffffffffffe') <> 1 or public.challenge_task_dhash_distance('zz', 'ffffffffffffffff') is not null then
    _bad := _bad || 'dhash'::text;
  end if;
  if not public.challenge_task_verdict_valid('general', '{"reason":"ok","placeholder":false,"inappropriate":false,"secret":false,"manipulation":false,"on_task":"yes","confidence":0.9}')
     or public.challenge_task_verdict_valid('general', '{"reason":"ok","placeholder":false,"inappropriate":false,"secret":false,"manipulation":false,"on_task":"yes","confidence":1.5}')
     or public.challenge_task_verdict_valid('general', '{"reason":"ok","placeholder":false,"inappropriate":false,"secret":false,"manipulation":false,"on_task":"yes","confidence":0.9,"x":1}')
     or not public.challenge_task_verdict_valid('instagram', '{"reason":"r","is_instagram_screenshot":true,"handle_seen":"a","tag_seen":true,"post_age_text":"2h","posted_recently":"yes","inappropriate":false,"manipulation":false,"confidence":0.8}') then
    _bad := _bad || 'verdict_valid'::text;
  end if;
  if public.challenge_task_norm_handle(' @AiCreators.Students ') <> 'aicreators.students' then _bad := _bad || 'norm_handle'::text; end if;
  -- the PR-1 parser honours ?thread= (G20) and the PR-2 requires validator (the calendar's CHECK)
  select p.chat, p.topic into _r from public.challenge_task_parse_topic_url('https://t.me/c/4440955972/5321?thread=144') p;
  if _r.chat is distinct from 4440955972 or _r.topic is distinct from 144 then _bad := _bad || 'parse_thread'::text; end if;
  if not public.challenge_task_requires_valid(_shot) then _bad := _bad || 'requires_valid'::text; end if;

  -- objects: 8 tables with RLS and no client grants; the two new triggers; the two cron jobs
  for _f in select unnest(array['challenge_task_submissions', 'challenge_task_messages', 'challenge_ig_posts', 'challenge_task_streak_awards',
                                'challenge_task_outbox', 'challenge_task_submit_claims', 'challenge_task_ai_calls', 'challenge_task_retry']) loop
    if to_regclass('public.' || _f) is null then
      _bad := _bad || ('missing:' || _f);
    elsif not (select relrowsecurity from pg_class where oid = ('public.' || _f)::regclass) then
      _bad := _bad || ('rls:' || _f);
    elsif exists (select 1 from pg_class c, aclexplode(c.relacl) a
                   where c.oid = ('public.' || _f)::regclass
                     and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))) then
      _bad := _bad || ('table_acl:' || _f);
    end if;
  end loop;
  if (select string_agg(a.attname || ':' || c.confdeltype::text, ',' order by a.attname)
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.conrelid = 'public.challenge_task_submissions'::regclass and c.contype = 'f' and c.confrelid = 'public.profiles'::regclass)
     is distinct from 'user_id:c' then
    _bad := _bad || 'submission_user_fk'::text;
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.challenge_tasks'::regclass and tgname = 'trg_challenge_tasks_zz_lock')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_zz_ig_handle_lock') then
    _bad := _bad || 'triggers'::text;
  end if;
  if (select count(*) from cron.job where jobname in ('challenge-tasks-reconcile', 'challenge-tasks-watchdog')) <> 2 then
    _bad := _bad || 'cron'::text;
  end if;
  -- functions: never PUBLIC / anon; authenticated exactly on the student/admin RPCs and the handle-lock helper
  for _r in
    select p.oid::regprocedure::text as sig, p.proname, coalesce(array_to_string(p.proacl, ','), '') as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'challenge\_task\_%' or p.proname like 'challenge\_tasks\_%' or p.proname like 'my\_challenge\_task%'
            or p.proname in ('reconcile_challenge_tasks', 'my_telegram_write_access_granted', 'admin_challenge_task_results',
                             'admin_challenge_task_override'))
       and p.proname not in ('challenge_task_parse_topic_url', 'challenge_task_topics', 'challenge_task_requires_valid',
                             'challenge_task_requires_problem', 'challenge_task_parse_message_url', 'challenge_task_render_post_text',
                             'challenge_task_post_length', 'challenge_task_post_context', 'challenge_task_render_post', 'challenge_tasks_guard')
  loop
    if _r.acl = '' or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)anon=' then
      _bad := _bad || ('acl_public:' || _r.sig);
    end if;
    if (_r.acl ~ '(^|,)authenticated=') <> (_r.proname in ('my_challenge_task_move', 'my_challenge_task_withdraw', 'my_challenge_task_restore',
                                                            'my_challenge_tasks', 'my_telegram_write_access_granted', 'admin_challenge_task_results',
                                                            'admin_challenge_task_override', 'challenge_task_ig_handle_locked')) then
      _bad := _bad || ('acl_authenticated:' || _r.sig);
    end if;
  end loop;
  -- the pinned rewrite landed
  if position('''challenge_task_streak''' in (select prosrc from pg_proc where oid = 'public.xp_award_integrity_watchdog()'::regprocedure)) = 0 then
    _bad := _bad || 'integrity_watchdog_labels'::text;
  end if;
  -- the live config parses clean (read-only)
  _c := public.challenge_tasks_config();
  if jsonb_array_length(coalesce(_c->'invalid', '[]'::jsonb)) <> 0 then
    _bad := _bad || ('config_invalid:' || (_c->'invalid')::text);
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: daily-tasks engine self-test failed: %', array_to_string(_bad, ', ');
  end if;
end $$;

-- ═══════════════════════════════ 16. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_tasks_engine_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_tasks_engine_applied', jsonb_build_object(
      'tables', jsonb_build_array('challenge_task_submissions', 'challenge_task_messages', 'challenge_ig_posts', 'challenge_task_streak_awards',
                                  'challenge_task_outbox', 'challenge_task_submit_claims', 'challenge_task_ai_calls', 'challenge_task_retry'),
      'crons', jsonb_build_array('challenge-tasks-reconcile 4-59/10', 'challenge-tasks-watchdog :47'),
      'config', (select jsonb_build_object('enabled', c->'enabled', 'ai', c->'ai', 'miniapp', c->'miniapp', 'active', c->'active')
                   from (select public.challenge_tasks_config() as c) x),
      'integrity_watchdog_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.xp_award_integrity_watchdog()'::regprocedure),
      'at', now()));
  end if;
end $$;
