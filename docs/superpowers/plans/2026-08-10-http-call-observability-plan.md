# HTTP-Call Observability (Track C1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (inline) to implement
> task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec:
> `docs/superpowers/specs/2026-08-10-http-call-observability-design.md`.

**Goal:** Make every automated `net.http_post` outcome durably visible and alertable, so silent HTTP
failures (measured live: 31 timeouts + 2 real 403s / 6h) surface within 30 min instead of never.

**Architecture:** A capture→classify→alert pipeline. A 10-min sweep copies pg_net failures into a
durable table before the ~6h GC; a 30-min watchdog classifies (expected Telegram noise vs real fault)
and DMs admins on real faults only; a health function feeds the daily digest + the external verifier.
A thin `ops_net_post` wrapper logs `request_id→sanitized-url/purpose` for attribution (lean rollout).

**Tech stack:** Postgres (pg_cron, pg_net), SQL SECURITY DEFINER functions, `platform_settings`
config, the existing admin-DM Telegram path, GitHub Actions (external verifier).

## Global Constraints

- Migrations are **new files** under `supabase/migrations/`, applied by the deploy pipeline **only**
  when the merged PR carries the **`migration-approved`** label; ledgered in `ops_applied_migrations`;
  never `db push`, never re-applied. UTC-timestamp filename prefix.
- **Never persist a secret.** Telegram URLs embed the bot token → sanitize every URL before storing;
  never store request headers/body; truncate/redact response `content` to ≤240 chars.
- New tables: **RLS on, zero policies** (service-role-only). SECURITY DEFINER posters: **revoke
  EXECUTE from public/anon/authenticated** (SSRF hardening).
- Self-merge to `main` requires the owner's explicit **"merge it"** per PR.
- `.github/**` changes ship as a **separate** commit/PR from the migration.
- Verify on prod with **synthetic** data; delete it after; assert zero residue.
- Preserve every existing reliability leg; add, don't regress.

---

### Task 1: Foundational tables + sanitizer + wrapper

**Files:** Create `supabase/migrations/20260810130000_ops_http_observability_tables.sql`

**Produces:** tables `ops_http_failures`, `ops_http_calls`; functions `ops_sanitize_url(text)→text`,
`ops_net_post(url,body,headers,purpose,timeout_ms)→bigint`.

- [x] **Step 1 (test-first):** validate the redaction regex + query-strip read-only on prod
  (token removed, non-token URLs untouched). *Done 2026-08-10 — all 4 cases pass.*
- [x] **Step 2:** validate the classifier expressions read-only (TG "blocked"→expected;
  `{"error":"forbidden"}`→real). *Done 2026-08-10.*
- [ ] **Step 3:** write the migration (tables + indexes + `ops_sanitize_url` immutable + `ops_net_post`
  SECURITY DEFINER with best-effort logging + revoke/grant hardening).
- [ ] **Step 4:** `migration-safety-reviewer` pass; fix findings.
- [ ] **Step 5:** commit `feat(ops): C1 http-observability tables + secret-safe net.http_post wrapper`.

### Task 2: Capture + classify + alert engine

**Files:** Create `supabase/migrations/20260810130100_ops_http_observability_engine.sql`

**Consumes:** Task 1 tables/functions. **Produces:** `ops_http_failure_sweep()→int`,
`ops_http_failure_watchdog()→jsonb`, `ops_http_health()→jsonb`, `prune_ops_http_observability()`,
`platform_settings.ops_http_watchdog` seed, crons `ops-http-sweep` (`*/10 * * * *`) and
`ops-http-watchdog` (`*/30 * * * *`).

- [ ] **Step 1:** `ops_http_failure_sweep()` — copy non-2xx/timed-out `net._http_response` rows since
  the watermark into `ops_http_failures` (`on conflict do nothing`), sanitized+truncated `content_snip`,
  LEFT JOIN `ops_http_calls`; advance `last_sweep_at`; audit only when count>0.
- [ ] **Step 2:** `ops_http_failure_watchdog()` — classify last window per spec §6; set
  `classification`; per-signature dedup (cooldown from config); alert on **real** via the existing
  admin-DM path (itself via `ops_net_post(..., purpose:='ops-http-alert')`); audit every alert.
- [ ] **Step 3:** `ops_http_health()` — return the §4.5 shape.
- [ ] **Step 4:** seed `platform_settings.ops_http_watchdog` (enabled, thresholds, cooldown, TG
  expected-phrase list); `prune_…` (30d failures / 3d calls); schedule the 2 crons; apply-time
  self-invoke of one sweep.
- [ ] **Step 5:** `migration-safety-reviewer` pass; fix findings. Commit.

### Task 3: Lean-wrap the critical alert POSTs

**Files:** Modify the highest-value POST sites (watchdog/anomaly/digest alerts; badge/hw/engagement
notifier invocations) to route through `ops_net_post(..., purpose:=…)`.

- [ ] **Step 1:** enumerate the critical POST sites (grep `net.http_post` in migrations/functions).
- [ ] **Step 2:** convert only those, passing a stable `purpose` label; leave the rest raw.
- [ ] **Step 3:** confirm no behavior change (same URL/body/headers); commit.

### Task 4: RUNBOOK.md

**Files:** Create `RUNBOOK.md` (repo root).

- [ ] One row per alert string → root-cause query → kill-switch → remediation, starting with the C1
  watchdog and back-filling existing watchdogs; kill-switch index. Commit.

### Task 5: Heal the live 403

- [ ] Correlate the `{"error":"forbidden"}` 403s to their caller (wrap suspects with `purpose`, watch
  one cycle, or match the `:45`/secret-gated set to the observed times).
- [ ] Identify the misconfigured Vault secret; **owner corrects it** (never printed here).
- [ ] Verify the 403 stops recurring in `ops_http_failures`.

### Task 6: External verifier assertion (separate PR)

**Files:** Modify `.github/workflows/hw-dm-health.yml` (or the health endpoint it curls) — **own commit/PR.**

- [ ] Assert `ops_http_health()`; fail the run on `real_faults_1h > 0` or `sweep_stale_min > 25`.

### Task 7: Cleanup

- [ ] Drop `reconcile_daily_active_xp()` if it still exists (cron already gone).
- [ ] Note the stale `wpdztrijasgmxgliwddr` ref in the two flagged migration sources (source hygiene
  for fresh-env rebuild; applied migrations are immutable).

### Task 8: E2E verification + record the lesson

- [ ] Run the spec §10 synthetic E2E on prod (inject fault → sweep → assert capture → watchdog →
  assert real classification + audit alert → dedup → expected-suppression fixture → delete → zero
  residue → health green).
- [ ] Update auto-memory: new memory *"pg_net silent-failure class + 6h TTL + ops_http_failures
  detector + kill-switch"*, linked from `MEMORY.md`.
