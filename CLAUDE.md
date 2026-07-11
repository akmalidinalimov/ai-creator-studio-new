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

## Verification bar

- E2E-verify on prod with synthetic users (create via `admin-create-students` with
  `x-internal-secret`; DELETE them after; assert zero residue).
- After any XP-touching change, confirm totals settle (xp_events are ref-key idempotent; the
  hourly `reconcile_all_xp()` must never double-award).
- Telegram constraints to check on every new button: callback_data ≤ 64 bytes (two UUIDs never
  fit — use positions/indices), bots can't DM users who never pressed Start (~70% of students),
  group-visible buttons need server-side owner locks.
