---
name: e2e-verify
description: E2E-verify a feature on production with synthetic students, per the platform verification bar. Creates and deletes real prod rows — user-invoked only.
disable-model-invocation: true
---

E2E-verify on production: $ARGUMENTS

The platform has no staging — verification runs on prod with SYNTHETIC users and
mandatory cleanup. Follow the bar from CLAUDE.md exactly.

## Procedure

1. **Create synthetic students** via the `admin-create-students` edge function with the
   `x-internal-secret` header (secret = `internal_fn_secret()` in Vault; owner-held if
   this session has no DB access). Mark them clearly: name prefix `E2E-TEST-`,
   provisional account_type unless the test needs full access.
2. **Exercise the exact user path** — not the RPC behind it. If the feature is a bot
   flow, drive it through real Telegram updates where possible; otherwise call the same
   edge-function endpoints the client calls, with the synthetic user's identity.
3. **Assert on the source-of-truth tables**, not on API responses: the row exists, the
   queue entry was created, the XP event has the right ref_key, the notification row
   reached `sent`.
4. **XP settle check** (mandatory if XP was touched): totals must settle — xp_events
   ref-key idempotent, and the hourly `reconcile_all_xp()` must not change anything on
   a second pass (run it twice, diff totals).
5. **DELETE the synthetic users** and assert ZERO residue: profiles, xp_events,
   homework_submissions, queue rows, group membership counts all back to baseline.
   The residue check is a query, not an assumption.
6. **Report**: what was created, what was asserted (with counts), what was deleted,
   and the final zero-residue proof.

## Hard rules

- Never test with real student accounts.
- Never leave synthetic rows behind — leaderboards and teacher views are live.
- If cleanup fails midway, STOP and report exactly which rows remain, with delete SQL.
