# AI Creators — project instructions

Production Supabase project: `cdyidatkegxwhtuoqxly` (ACADEMY). Vercel deploys from `main`.
Self-merges to `main` require the owner's explicit "merge it" per PR.

## Deploys & migrations (autonomous-ops pipeline — since 2026-07-12)

- Merges to `main` auto-deploy via `.github/workflows/deploy-supabase.yml`: changed edge
  functions deploy directly (ALL when `supabase/config.toml` changes); NEW migration files apply
  ONLY when the merged PR carries the `migration-approved` label, and are ledgered in
  `ops_applied_migrations` (never `db push`, never re-applied). **Do NOT deploy functions or
  apply migrations manually anymore** — commit, PR, merge; the pipeline does the rest.
- Telegram approve flow: `ops-notify` edge fn DMs admins with `ops:a:<pr#>`/`ops:reject:<pr#>`
  buttons; the bot webhook's `ops:` callback (admin-only, impersonation-denied) verifies the PR
  (label `ops-agent`, branch `ops/*`, same-repo head, must NOT touch `.github/**`) and requires
  **CI check-runs green** (`checksAllGreen` in `telegram-bot-webhook/ops-approve.ts` — this IS
  the merge gate; the repo is on the GitHub Free plan, no server-side branch protection), then
  two-tap confirm → squash-merge.
- Secrets: `ops_github_pat()` / `ops_notify_secret()` read Vault (owner-inserted values); NULL =
  flow gracefully dormant. Kill-switches: remove the Vault secret (merges impossible), disable
  the workflow in the Actions UI, `platform_settings.ops_agent.enabled` (Phase 4 dispatch).
- Agent-authored PRs (Phase 3+) always land on `ops/*` branches with the `ops-agent` label and
  may never touch `.github/**`, `supabase/migrations/**`, or secrets.

## The incident doctrine (self-learning loop) — MANDATORY

When ANY bug, complaint, or anomaly is encountered, never fix just the instance. Run the full loop:

1. **Reproduce & root-cause from evidence** — query `webhook_inbox` (every Telegram update is
   persisted raw), `homework_teacher_dm_queue.error`, `admin_actions`, function logs
   (`/analytics/endpoints/logs.all`), and the tables themselves. No fix without a verified
   failure sequence.
2. **Fan out the class** — before writing the fix, enumerate every sibling scenario: same bug in
   other code paths, other callback prefixes, other flows (bot flow / picker / auto / web), race
   variants, and quantify blast radius with SQL (how many students/rows affected, since when).
   Precedent: one 84-byte callback bug → audit of every button found two more dead screens.
3. **Fix the class, not the case** — shared engines over per-path patches; one pending rule used
   by every view; atomic SQL (claims, jsonb appends) over read-modify-write.
4. **Heal history** — a fixed bug usually left damage behind. Write the backfill/reconciler that
   repairs old rows (idempotent, ref-key/cycle-deduped), run it, verify counts.
5. **Add a detector** — every failure class gets an automated signal that fires BEFORE the next
   complaint: DB-side watchdog (SQL + pg_net → Telegram DM to admins), a field in
   `hw_dm_health_stats()`, and/or the out-of-band GitHub verifier
   (`.github/workflows/hw-dm-health.yml`, daily 03:25 UTC — unreachable = alert, by design).
   **Rule: new features must emit DB-visible health signals** — errors that live only in
   function logs are invisible to the watchdog layer.
6. **Record the lesson** — update the auto-memory files (esp. `homework-capture-incident`) with
   root cause + kill-switch + detector location, so the next session starts smarter.

Reliability architecture to preserve (do not regress): triggers are the instant path, hourly/15-min
reconcilers re-derive from source-of-truth tables, SQL fallbacks deliver when the edge stack is
down, watchdogs alert humans, and the GitHub verifier audits from OUTSIDE Supabase daily. Every
leg must stay independent of the thing it watches.

## Prevention hierarchy — before you build a watchdog (self-learning loop, part 2)

A watchdog only *detects* what already escaped. Most recurring failures are a few repeatable footgun
patterns, so the leverage is to make the *class* impossible-or-loud **by construction** rather than
watch each instance. When a failure recurs, work DOWN this hierarchy and add a watchdog only for what
genuinely can't be prevented upstream:

1. **Unrepresentable (primitive/type).** Route it through a paved-road primitive so the bad state
   can't be written. Writes → `mutate()` / `mutateMany()` / `saveWithToast()` (`src/lib/mutate.ts`):
   a 0-row RLS-filtered write is `not_saved`, never a false "saved" (and an impersonation no-op is an
   expected result — never beacon it). Telegram sends → `sendTelegram()`
   (`supabase/functions/_shared/telegram-send.ts`): every non-delivery is DB-visible by construction.
   Edge scaffolding → `_shared/edge.ts` (`corsHeaders` / `json` / `logHealth`). **Never hand-roll a
   raw `supabase…update()/upsert()` or `fetch("…api.telegram.org…")`** — `npm run lint:footguns`
   finds and (once the legacy sites are migrated) forbids them.
2. **Invariant (DB).** A property that must never be bypassed by *any* code path belongs in a
   CHECK / trigger / RLS, not in hoped-for app code (see the existing guards).
3. **Author-time (lint/types).** A lint rule (the footguns config) or a strict type that fails in the
   editor + CI. Prefer un-writable over caught-at-runtime.
4. **CI test.** A test on the mutation path with the REAL data shapes (a *video/document* homework,
   an RLS-blocked write) — not just the happy case.
5. **Runtime watchdog.** The backstop, for genuinely emergent properties only (drift, spikes,
   delivery liveness). NOT for "did this one write/send succeed" — that is layer 1's job now.

**Graceful is not silent:** every fallback path (an "open in Telegram", a "not available", a "try
again") MUST also emit a counter/signal, or a broken feature hides behind a friendly HTTP 200.

## Verification bar

- E2E-verify on prod with synthetic users (create via `admin-create-students` with
  `x-internal-secret`; DELETE them after; assert zero residue).
- After any XP-touching change, confirm totals settle (xp_events are ref-key idempotent; the
  hourly `reconcile_all_xp()` must never double-award).
- Telegram constraints to check on every new button: callback_data ≤ 64 bytes (two UUIDs never
  fit — use positions/indices), bots can't DM users who never pressed Start (~70% of students),
  group-visible buttons need server-side owner locks.

## Members vs. non-members: forgiving sandbox vs. strict gate

The Telegram **group membership is the trust boundary** (enforced in `telegram-bot-webhook`
2026-07-13). Two asymmetric contracts — keep every future change on this axis:

- **Non-members are gated hard.** An unknown Telegram user who isn't a member of any
  active-course group gets ONE plain sentence (`nmNotMember`) — no keyboards, no buttons, no
  enrollment links, no account. First-time username→profile linking (bot AND website-login
  paths) requires membership, because usernames are squattable (account-takeover class).
  Gate/refusal events are DB-visible (`admin_actions`: `username_link_refused`,
  `membership_gate_indeterminate`).
- **Members get a forgiving sandbox.** A registered student — or any group member — resolves by
  `telegram_id` and NEVER hits a gate, throttle, or membership probe (those run only for users
  with no profile). Their fumbling is expected and must stay cheap and un-flagged:
  - Wrong/stale/expired button taps → friendly message, never an error, work never lost
    (`pkNotYours`/`pkExpired`/`pkGradedAlready`; retag preserves score+history).
  - Posting homework in another group's topic → in-thread redirect hint (rate-limited 15 min).
  - Posting anything in their OWN group's non-homework topics → **leave them alone.** It's their
    space; the bot must NOT police or comment on general-chat posts. Silence is correct here.
  - Member activity must never inflate an owner-facing anomaly/health flag. The uncaptured
    detector already excludes anything that created a pending post or submission (picker mode
    creates one for every homework-topic media), so member chatter doesn't trip it — preserve
    that property when touching detectors.
  - Never apply the expensive `getChatMember` sweep or the unregistered-reply throttle to a
    user who already has a profile.
