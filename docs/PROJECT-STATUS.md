# Project status — continue here

_Last updated: 2026-07-13. Human-readable handoff; the authoritative rules live in
[`/CLAUDE.md`](../CLAUDE.md) and the assistant's auto-memory._

## Where things stand

Everything built recently is **merged, deployed, and verified on production**. `main` is clean.
The autonomous-ops pipeline (Phases 1+2) is live and E2E-tested; Phases 3–5 are pending a soak
period.

### Shipped this cycle (all on `main`)
| PR | What |
|----|------|
| #11–#14 | Deploy pipeline + Telegram approve-loop + phone-tap ceremony (Phases 1+2) |
| #15 | CI read via GitHub Actions API (fine-grained PATs can't get the Checks permission) |
| #16 | Statistics-first admin keyboard — 📊 overall + per-group drill-down (`ast:` callbacks) |
| #17 | Claude Code project setup — protection hooks, 3 review subagents, doctrine skills |
| #18 | Cron-failure watchdog + instant new-joiner alert + PAT-expiry countdown (2 migrations) |
| #19 | Membership gate + username-squat takeover fix + member-forgiveness doctrine |

### Live configuration
- **Deploys**: merge to `main` → `deploy-supabase.yml` deploys changed edge functions; NEW
  migrations apply only with the `migration-approved` label, ledgered in `ops_applied_migrations`.
  **Never deploy/migrate by hand.**
- **Approve loop**: `ops-notify` DMs admins a PR with ✅/❌ buttons; two-tap confirm → squash-merge.
  Merge gate = `checksAllGreen` (Actions API). Secrets in Supabase Vault + GH Actions.
- **Homework capture**: `platform_settings.homework_capture` = `picker`, scoped to the 5.0 course,
  `auto_register: true` (unknown group members auto-onboard as provisional; non-members are gated).
- **Bot access**: group membership is the trust boundary — non-members get one plain message,
  members get a forgiving sandbox (see CLAUDE.md “Members vs. non-members”).

### Detectors / self-healing (all independent of the thing they watch)
- Minute drainer + retries + cycle-aware reconciler + SQL fallback for teacher DMs.
- `hw_dm_health_stats()` + hourly `platform_anomaly_digest()` → admin Telegram (now also alerts on
  **cron-job failures**).
- `new-student-alert-flush` cron (every minute) → aggregated new-joiner DM.
- Out-of-band GitHub verifier `hw-dm-health.yml` (daily 03:25 UTC) — also warns when the ops PAT
  nears its **2026-10-10** expiry (fires from Oct 1).

## Open items (soft — nothing is blocking)

1. **Resubmit-campaign stragglers** — 12 of ~20 asked students had resubmitted as of 2026-07-12.
   Recheck; send a reminder only on explicit request. Use a guard-flag one-shot, **not** a
   self-unscheduling cron (self-unschedulers log `status='failed'` even on success).
2. **Phase 3 (autonomous investigator)** — greenlight after a few quiet soak days. Prereqs:
   `ANTHROPIC_API_KEY` (with a $50/mo cap set in the Anthropic console) and a second fine-grained
   PAT `OPS_GH_PAT`, both as GitHub Actions secrets. Then build `ops-investigate.yml`
   (workflow_dispatch first). Full plan: `.claude/plans/crystalline-drifting-mccarthy.md`.
3. **Optional**: GitHub Pro (~$4/mo) for real server-side branch protection under the app-level gate.

## Kill-switches (if anything misbehaves)
- Deploys/approve-loop: disable the workflow in the GitHub Actions UI, or remove the Vault secret.
- Homework auto-register: flip `platform_settings.homework_capture.auto_register` to `false`
  (non-member gating and joiner alerts still work).
- Phase-4 agent dispatch (future): `platform_settings.ops_agent.enabled`.
