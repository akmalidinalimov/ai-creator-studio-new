# Reliability Hardening — Spec

**Status:** in progress · **Owner-requested** after the adversarial self-review of the detection layer.
**Goal:** close the six blind spots in the "reliability ladder" (see the *Reliability Architecture* artifact),
in priority order, each as its own shippable change.

The detection layer today is strong at catching **failures that get recorded and stay bounded**, and weak
at three things: **silence** (a failure that produces no row), **self-monitoring** (a dead watchdog can't
report its own death), and **out-of-band alerting** (the alarm about Telegram travels over Telegram). This
spec fixes those first, then the softer edges.

Everything here is **additive** and follows the established patterns (`watch_gate_watchdog` for detectors,
`hw_dm_health_stats()` + `hw-dm-health.yml` for the out-of-band verifier). No behavior of the shipped fixes
(#119/#120/#122) is regressed.

---

## Priority-ordered solutions

### P0-1 — Delivery-silence detection ("the dog that didn't bark")
**Problem.** `grade_delivery_watchdog` counts *failure* rows. A grading-flow bug that stops the grade DM from
being *attempted* produces **zero** rows → the watchdog sees 0 and reports healthy while every student
silently gets no grade. Total silence and perfect health are indistinguishable to a failure-counter.

**Design.**
1. Emit a **success heartbeat**: in `telegram-bot-webhook` grade-card path, on a delivered card record an
   `admin_actions` row `action='grade_card_dm_sent'` (symmetric with the existing `grade_card_dm_failed`).
   Low volume, consistent with the existing `homework_submission_dm_sent` / `badge_dm_sent` heartbeats.
2. Add a **silence clause** to `grade_delivery_watchdog`: over a 48h window, if homework was *scored*
   (`homework_submissions.scored_at`) above a floor **but** the grade-card path emitted **no** signal at all
   (`grade_card_dm_sent + grade_card_dm_failed == 0`) → alarm *"N grades saved in 48h, 0 grade-card DMs — the
   delivery path may be dead."* The 48h window + a floor avoids a quiet-period false positive.

**Files.** `supabase/functions/telegram-bot-webhook/index.ts` (success row) + a migration extending
`grade_delivery_watchdog()`. **Acceptance.** A synthetic state (scored rows present, zero grade-card signals)
sets `alerting=true`; a normal state (signals present) does not.

### P0-2 — Watchdog liveness heartbeat + a non-Telegram alarm (who watches the watchmen + circular alert)
**Problem.** (a) Every in-Supabase leg shares `pg_cron`/`pg_net`; if that dies, all 9 watchdogs die *silently
together* and can't report it. The out-of-band GitHub verifier only checks the homework-DM leg — not that the
watchdogs are alive. (b) Every watchdog DMs admins over Telegram; if the failure *is* Telegram (token revoked),
the alarm can't get out.

**Design.** Extend the **out-of-band** leg — the one path that survives a total Supabase/Telegram outage and
alerts via GitHub email:
1. `hw_dm_health_stats()` returns `stale_watchdogs` — the count (and names) of the 9 `*_watchdog_state`
   rows whose `checked_at` is older than 25h.
2. It also returns `telegram_send_broken_24h` — the count of **transient/content** (non-recipient)
   `telegram_send_failed` in 24h, a proxy for "Telegram itself is failing."
3. `hw-dm-health.yml` asserts: `stale_watchdogs > 0` → `::error::` (fail = email); a
   `telegram_send_broken_24h` spike → `::error::`. Both alarms reach the owner **without** Telegram or
   `pg_cron`.

**Files.** migration (`hw_dm_health_stats()` — the *latest* definition, 2026-08-18) + `.github/workflows/hw-dm-health.yml`.
**Acceptance.** A stale watchdog state fails the workflow; a telegram-broken spike fails it.

### P1-3 — Recipient-class trend (a mass regression masked by the "expected" exclusion)
**Problem.** The watchdog excludes recipient-class failures (~70% never-Started) as "expected reach." A bug
that makes *everyone* fail as a recipient error (e.g., corrupted `telegram_id`s → "chat not found") is filtered
out → invisible while 100% of delivery stops.

**Design.** Add a clause to `grade_delivery_watchdog`: track `telegram_send_failed` **recipient-class** volume
in the last 24h against a trailing 7-day daily average. A large jump (e.g., > 3× baseline and above a floor)
→ alarm *"recipient-class non-delivery spiked Nx over baseline — a regression may be masquerading as expected
reach."* This turns the exclusion from a blind spot into a monitored trend.

**Files.** migration (`grade_delivery_watchdog()`). **Acceptance.** A synthetic 3× recipient spike alarms; a flat
baseline does not.

### P2-4 — Fast-path detection (cut the ~24h latency)
**Problem.** The watchdog runs daily; an acute outage right after a run isn't caught for ~24h.

**Design.** Add an **hourly** run of `grade_delivery_watchdog` on a short (2h) window with a lower floor for
*acute* spikes, keeping the daily 24h summary. Or a `grade_delivery_watchdog_fast()` sibling scheduled hourly.
Detection for a real outage drops from ~24h to ~1h.

**Files.** migration (cron + a fast variant / windowed param). **Acceptance.** A 2h spike alarms within the hour.

### P2-5 — Classifier robustness + threshold + lint-evasion (softer edges)
**Problem.** (a) recipient/content classification is a regex on Telegram's *description strings* — Telegram
changing its wording drifts classification silently; (b) static thresholds don't scale; (c) the blocking lint
matches the literal `api.telegram.org` and a dynamically-built URL slips past.

**Design.**
- A **deno test** pinning the known Telegram error strings against `telegram-classify.ts`, plus a
  `telegram_unclassified_24h` counter (a `telegram_send_failed` whose error matches neither recipient nor
  content) surfaced to the watchdog/verifier — a new/unmatched error string becomes visible.
- Prefer **baseline-relative** thresholds where added (already the approach in P1-3).
- Lint-evasion: a note + optional runtime audit; low priority (a dynamically-built sender is an unusual,
  reviewable pattern).

**Files.** `supabase/functions/_shared/telegram-classify.test.ts` (new) + optional watchdog/stats field.
**Acceptance.** The test fails if a pinned error string reclassifies; the unclassified counter is queryable.

---

## Execution order
P0-1 → P0-2 → P1-3 → P2-4 → P2-5. One PR per item (P2-5 may bundle). Migrations carry the `migration-approved`
label; each is modeled on an existing sibling and reviewed (`migration-safety-reviewer` for SQL,
`telegram-flow-reviewer` for edge changes). Verified on prod after merge (function exists, ledgered,
self-test clean).
