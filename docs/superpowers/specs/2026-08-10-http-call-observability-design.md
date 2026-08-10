# Reliability Hardening C1 — HTTP-Call Observability — Design Spec

**Date:** 2026-08-10
**Track:** C (Reliability hardening) — spec 1 of a planned 3
**Status:** Design — awaiting owner review before implementation plan
**Author:** platform audit follow-up

---

## 1. Problem & evidence

Every automated action on this platform that reaches the outside world — every watchdog
alert, every badge/homework/engagement DM, every cron that invokes an edge function — goes
through `pg_net`'s `net.http_post`. That call is **asynchronous**: it returns success the moment
the request is *queued*, not when it succeeds. The result lands in `net._http_response`, and
**no code anywhere reads it back**. So an HTTP failure — a blocked Telegram endpoint, a 500 from
an edge function, a cron calling a function with a rotated secret — is completely invisible to
every existing watchdog, digest, and the incident doctrine.

This is not theoretical. Measured on prod `cdyidatkegxwhtuoqxly` on 2026-08-10 (a single ~6h window):

| Signal | Count / 6h | Meaning |
|---|---|---|
| `200` OK | 1,216 | healthy |
| `timed_out` (5000 ms) | **31** | all hit the pg_net 5s default; many spent the full 5s in *DNS time*, clustered at `:00`/`:30` — the classic signature of pg_net queue congestion when many crons fire at once |
| `403 {"error":"forbidden"}` | **2** | **our own** edge-function secret-rejection body — a cron is calling a secret-gated function with a bad/rotated secret and silently 403ing |

Two structural facts (measured, not assumed) shape the whole design:

- **`net._http_response` self-deletes after ~6 hours** (measured retention: **5.98h** — pg_net's
  built-in GC). A watchdog reading this on a daily schedule sees nothing; the failures are already
  gone. **The capture job must run frequently and persist failures to a durable table.**
- **`net._http_response` has no URL column, and `net.http_request_queue` is emptied on
  completion** (verified: 0 pending rows; columns `id, method, url, headers, body,
  timeout_milliseconds`). So after a call finishes, the URL is unrecoverable. **Attribution — knowing
  *which* endpoint failed — requires capturing the `request_id → url/purpose` mapping at call
  time.**

Two audit suspicions were **cleared** by the same evidence and are therefore *not* in scope:
- **Dead crons on the old project ref** — 0 of 36 live crons reference `wpdztrijasgmxgliwddr`; the
  jobs the audit flagged already point at the current ref. Only the *repo migration source* is
  stale (a fresh-env rebuild risk only — handled as a minor cleanup item).
- **Orphan `reconcile_daily_active_xp` cron** — not scheduled on prod. Moot.

## 2. Goals & non-goals

**Goals**
1. Make every `net.http_post` outcome **durably visible** in the database, surviving pg_net's 6h GC.
2. **Attribute** failures to a caller/endpoint (incrementally — see §4.2).
3. **Alert admins on real faults only**, cleanly separated from expected noise (Telegram
   "user blocked the bot" 403s from the ~70% who never pressed Start).
4. **Heal history:** find and fix the live 403 secret misconfiguration this surfaced.
5. Emit a **DB-visible health signal** the daily digest and the external GitHub verifier can assert
   on — per the incident doctrine ("new features must emit DB-visible health signals").

**Non-goals (deferred to later Track C specs — keep this one shippable)**
- Second independent alert channel (email / second bot) for when Telegram itself is down → **C2**.
- Broad `console.error → platform_error_log` sweep across the 29 log-only edge functions → **C2**.
- Promoting alert-only watchdogs to auto-heal → **C3**.
- CI migration dry-run / broader edge test coverage → **C3**.
- Cron-schedule staggering / per-call timeout tuning to cut the `:00`/`:30` timeout bursts →
  **follow-up**, only after this spec's data quantifies which endpoints/times actually hurt
  (owner decision 2026-08-10: *measure first, tune later*).

**Owner decisions locked (2026-08-10):**
- Attribution rollout = **lean / incremental** (wrap the critical alert POSTs now; migrate the
  rest opportunistically).
- Timeout bursts = **measure first**; no schedule/timeout changes in this spec.

## 3. Architecture overview

A five-stage pipeline that plugs into the platform's existing defense-in-depth pattern
(trigger → reconciler → SQL fallback → watchdog → **external verifier**):

```
net.http_post (existing callers, unchanged)
        │  (optionally via ops_net_post → logs id→url/purpose at call time)
        ▼
net._http_response  ── pg_net, ~6h TTL, no URL, no reader ──┐
        │                                                    │
   [ ops_http_failure_sweep() ]  cron */10min                │ 6h later: GC deletes the row
        │  copy non-2xx / timed_out rows, sanitized,         │
        │  LEFT JOIN ops_http_calls for url/purpose          ▼
        ▼                                                 (gone)
public.ops_http_failures  ── durable, service-role-only, pruned at 30d
        │
   [ ops_http_failure_watchdog() ]  cron */30min
        │  classify last window → EXPECTED (suppress) | REAL (alert)
        │  per-signature dedup (cooldown)
        ├── REAL → DM admins (existing Telegram admin-DM path)
        └── writes admin_actions audit rows
        │
   [ ops_http_health() ]  ← ops_daily_digest (heartbeat)  ← external GitHub verifier (independent leg)
```

**Independence principle preserved:** the watchdog itself alerts *through* pg_net/Telegram — the
very channel that might be failing. So the **independent leg is the external GitHub-Actions verifier**
asserting on `ops_http_health()` from outside Supabase; if the watchdog can't get a Telegram message
out, the external verifier's daily assertion (and the absence of the `ops-daily-digest` heartbeat)
is what catches it. This spec extends the existing external verifier rather than adding a new inside-
Supabase-only signal.

## 4. Components

### 4.1 `public.ops_http_failures` (durable failure log)

```sql
create table public.ops_http_failures (
  response_id   bigint primary key,          -- = net._http_response.id (idempotent capture)
  status_code   int,                         -- null when timed out
  timed_out     boolean not null default false,
  error_msg     text,                         -- pg_net transport error (e.g. "Timeout of 5000 ms…")
  content_snip  text,                         -- response body, sanitized + truncated ≤ 240 chars
  url           text,                         -- sanitized (token-stripped) — null if caller not wrapped
  purpose       text,                         -- caller-supplied label — null if not wrapped
  classification text,                        -- 'expected' | 'real' | 'unknown' (set by watchdog)
  occurred_at   timestamptz not null,         -- = net._http_response.created
  captured_at   timestamptz not null default now()
);
```
- **RLS enabled, zero policies** (service-role-only), matching the other `ops_*` tables.
- `response_id` PK ⇒ the sweep is idempotent (`on conflict do nothing`); overlapping sweeps can't
  double-insert.
- Index on `(occurred_at)` for windowed watchdog reads; index on `(classification, occurred_at)`.
- **Retention:** a `purge_old_ops_http_failures()` step (30-day window) folded into the existing
  weekly purge cadence (dovetails with Track D retention).

### 4.2 `ops_net_post()` wrapper + `ops_http_calls` mapping (lean rollout)

```sql
create table public.ops_http_calls (
  request_id  bigint primary key,   -- = value returned by net.http_post
  url         text not null,        -- SANITIZED at insert (see §9 secret hygiene)
  purpose     text,                 -- human label, e.g. 'watchdog-alert', 'badge-dm'
  created_at  timestamptz not null default now()
);

create function public.ops_net_post(
  p_url text, p_body jsonb default '{}'::jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms int default 5000
) returns bigint            -- returns the net request_id
language plpgsql security definer set search_path=public as $$
declare _id bigint;
begin
  _id := net.http_post(url:=p_url, body:=p_body, headers:=p_headers, timeout_milliseconds:=p_timeout_ms);
  begin
    insert into public.ops_http_calls(request_id, url, purpose)
    values (_id, public.ops_sanitize_url(p_url), p_purpose)
    on conflict (request_id) do nothing;
  exception when others then null;  -- logging is best-effort; never break the send
  end;
  return _id;
end $$;
```
- **Lean rollout (owner decision):** migrate only the **highest-value alert POSTs** to `ops_net_post`
  in this spec — the watchdog/anomaly/digest alert sends and the badge/homework/engagement notifier
  invocations — so their failures are attributable immediately. The remaining ~14 callers keep raw
  `net.http_post`; their failures still land in `ops_http_failures` (with `url/purpose = null`) and
  are still classified by response shape. They get wrapped opportunistically in later work.
- `ops_http_calls` is pruned aggressively (3-day window — it only needs to outlive the 6h response
  TTL for the sweep to join).
- `ops_sanitize_url()` — pure helper, see §9.

### 4.3 `ops_http_failure_sweep()` — capture (cron `*/10 * * * *`)

- Reads `net._http_response` rows with `created > last_sweep_watermark` where
  `status_code >= 400 OR status_code IS NULL OR timed_out OR error_msg IS NOT NULL`.
- For each: `insert … on conflict (response_id) do nothing` into `ops_http_failures`, storing a
  **sanitized, truncated** `content_snip` (≤240 chars, token-redacted) and `LEFT JOIN ops_http_calls`
  on `response_id = request_id` for `url`/`purpose`.
- `classification` left null here; set by the watchdog (keeps capture cheap and dumb).
- Runs every 10 min ⇒ worst-case a failure lives ~6h in pg_net, captured within 10 min — no loss.
- Returns count captured; writes a lightweight `admin_actions` row only when count > 0.

### 4.4 `ops_http_failure_watchdog()` — classify + alert (cron `*/30 * * * *`)

Reads **from the durable `ops_http_failures`** (never the ephemeral pg_net table) for the last
window, sets `classification`, and alerts on REAL faults only. Classifier (§6). Dedup: per
`(classification, coalesce(purpose,url,'?'), status_code)` signature, at most one alert per
**cooldown** (default 3h), using the established per-signature `last_alert` state pattern (a small
`ops_http_alert_state` jsonb in `platform_settings`, mirroring the reputation SB/VT dual-clock).
Every alert and every suppression-of-note writes an `admin_actions` audit row.

### 4.5 `ops_http_health()` — health signal (jsonb)

Returns e.g.:
```json
{ "last_sweep_at": "…", "sweep_stale_min": 6, "real_faults_1h": 0, "real_faults_24h": 1,
  "timeouts_1h": 4, "expected_suppressed_24h": 2, "open_real_signatures": ["forbidden@fn:xxx"],
  "watchdog_enabled": true }
```
- Consumed by `ops_daily_digest` (morning heartbeat) **and** the external verifier (§4.7).

### 4.6 Heal history — the live 403

A one-shot investigation + fix task (in the plan): correlate the `{"error":"forbidden"}` 403s
(timestamps 04:32 / 04:45 on 2026-08-10) to their caller by (a) temporarily wrapping the suspect
secret-gated crons with `ops_net_post(..., purpose:=…)` and watching one cycle, or (b) matching the
`:45`-hourly / secret-gated function set against the observed times, then correcting the misconfigured
secret (Vault value — **owner-inserted**, never printed). Verify the 403 stops recurring in
`ops_http_failures`.

### 4.7 External verifier extension

Extend `.github/workflows/hw-dm-health.yml` (or the health endpoint it curls) to also assert
`ops_http_health()`: **fail the run** when `real_faults_1h > 0` or `sweep_stale_min > 25` (sweep
wedged). Keeps the one leg that survives total Supabase/pg_net death covering this new class too.
*(The `.github/**` "never touch" rule binds the **autonomous** ops agent, not this interactive
owner-present session — the workflow edit is authored here, isolated in its own commit so it can be
reviewed and merged separately from the migration PR, and merged only on the owner's explicit "merge
it".)*

### 4.8 Cleanup (minor)

- Fix the stale `wpdztrijasgmxgliwddr` ref in the **repo** source of the two flagged migrations so a
  fresh-env rebuild doesn't reintroduce dead crons. (Already-applied migrations are immutable and
  correct on prod; this is source hygiene only — a comment/no-op note, since we never rewrite applied
  migration files that are ledgered.)
- Drop the dead `reconcile_daily_active_xp()` function if it still exists (cron already gone).

### 4.9 `RUNBOOK.md`

New top-level `RUNBOOK.md`: one row per alert string → root-cause query → kill-switch → remediation,
starting with this watchdog and back-filling the existing ones (enrollment, hw-dm, badge, broadcast,
reputation, anomaly-digest), plus a kill-switch index (Vault secrets, `platform_settings.*.enabled`,
workflow toggles).

## 5. Data flow (worked example — the live 403)

1. A secret-gated cron POSTs to its edge function with a stale secret → function returns
   `403 {"error":"forbidden"}` → row in `net._http_response` (status 403, content `{"error":"forbidden"}`).
2. Within ≤10 min, `ops_http_failure_sweep()` copies it into `ops_http_failures` (sanitized content,
   `url/purpose` if that caller was wrapped, else null).
3. Within ≤30 min, `ops_http_failure_watchdog()` classifies it **REAL** (our-format 4xx, §6), and —
   first time for this signature within the cooldown — DMs admins: *"⚠️ HTTP fault: 403 forbidden from
   `<purpose|url>` ×N in last 30m — likely a misconfigured function secret."* + writes `admin_actions`.
4. `ops_http_health()` now reports `real_faults_1h ≥ 1`; the external verifier's next run fails loudly
   even if the Telegram DM never arrived.
5. Owner corrects the Vault secret; the 403s stop; the signature ages out; health returns to green.

## 6. Classifier rules

| Observed | Host / shape | Class | Action |
|---|---|---|---|
| `403` body matches Telegram *"bot was blocked" / "can't initiate" / "chat not found" / "user is deactivated" / "bot was kicked"* | `api.telegram.org` | **expected** | suppress; count into `expected_suppressed` |
| `403 {"error":"forbidden"}` (our body) or any `401` | our functions / non-Telegram | **real** | alert — secret/auth misconfig |
| `400` to Telegram (*"can't parse" / "message is too long" / "wrong file identifier"*) | `api.telegram.org` | **real** | alert — payload bug |
| any `5xx` | any | **real** | alert |
| any other `4xx` | any | **real** | alert |
| `timed_out` / null status | any | **rate-based** | alert only if `timeouts_in_window > threshold` (default 20 / 30m) **or** sustained across 2 consecutive windows; otherwise record-only |
| unmatched | any | **unknown** | record-only, included in health `real_faults` count if `>= 400` |

Thresholds and the Telegram expected-phrase list live in `platform_settings.ops_http_watchdog` so
they're tunable without a deploy.

## 7. Error handling & idempotency

- Capture: `on conflict (response_id) do nothing` — overlapping/retried sweeps are safe.
- Wrapper logging and all `admin_actions` writes are wrapped `exception when others then null` — a
  logging failure must **never** break a real send or an alert.
- Watchdog re-runs are convergent: classification is a deterministic function of the stored row;
  dedup state gates the *alert*, not the *classification*, so re-runs don't re-alert.
- Sweep watermark stored in `platform_settings.ops_http_watchdog.last_sweep_at`; a missed sweep just
  widens the next window (bounded by pg_net's 6h retention).

## 8. Kill-switches & config

- `platform_settings.ops_http_watchdog.enabled = false` → watchdog stops alerting (capture may keep
  running harmlessly, or gate both on the flag).
- Unschedule `ops-http-sweep` / `ops-http-watchdog` crons → full stop; tables go passive.
- All thresholds, cooldown, and the Telegram expected-phrase list are config, not code.

## 9. Security & secret hygiene (critical)

**This is the highest-risk part of the spec and must be enforced exactly:**

- **Telegram URLs embed the bot token** (`https://api.telegram.org/bot<TOKEN>/sendMessage`). The
  wrapper MUST pass every URL through `ops_sanitize_url()` **before** storing: replace `/bot<token>/`
  with `/bot<redacted>/` and strip any query string. `ops_http_calls.url` and `ops_http_failures.url`
  therefore never contain a token. (Consequence for §5: alerts reference `purpose` first, sanitized
  host second — never a raw URL.)
- **Never store request headers or body.** They carry the service-role key and internal secrets.
  The sweep only ever reads the *response* side of `net._http_response`; the wrapper deliberately
  does not persist `p_headers`/`p_body`.
- **`content_snip` is truncated (≤240 chars) and token-redacted** (regex-strip anything matching a
  bot-token / bearer / long-hex shape). Response bodies may contain minor Telegram PII
  (chat id / first name); a service-role-only table is an acceptable home (consistent with
  `webhook_inbox` already storing raw updates), but truncation limits exposure.
- Both new tables: **RLS on, no policies** (service-role only). No client, no anon, no
  `authenticated` access.
- Nothing in this spec prints, echoes, or commits a secret value; the 403 remediation is an
  owner-performed Vault update.

## 10. Testing & E2E verification

**Deno/unit (where logic is extractable):** `ops_sanitize_url()` token/query stripping table-tests
(token in path, token + query, non-Telegram URL untouched, null-safe). Classifier decision table
tests (each row of §6 → expected class) as pure-SQL fixtures.

**Prod E2E (synthetic, zero-residue — per the verification bar):**
1. `select ops_net_post('https://<our-project>.functions.supabase.co/__nonexistent__','{}'::jsonb,
   '{}'::jsonb,'synthetic-http-test')` → forces a 404/403.
2. Run `ops_http_failure_sweep()` → assert exactly one `ops_http_failures` row with
   `purpose='synthetic-http-test'` and a sanitized url.
3. Run `ops_http_failure_watchdog()` → assert `classification='real'` and an `admin_actions` alert
   row (route the DM to a test-only chat or assert the audit row, not a real broadcast).
4. Re-run the watchdog within cooldown → assert **no** second alert (dedup).
5. Inject a synthetic *expected* row (content mimicking Telegram "bot was blocked") → assert
   `classification='expected'` and no alert.
6. `delete from ops_http_failures where purpose='synthetic-http-test'` (+ the expected fixture) and
   from `ops_http_calls`; assert zero residue.
7. Confirm `ops_http_health()` returns to `real_faults_1h = 0`.

**Regression:** confirm the wrapped critical POSTs still deliver (badge/hw/engagement DMs unaffected);
`deno check` on any touched function shows no net-new type errors.

## 11. Rollout

- All new objects ship as **new migration files** under `supabase/migrations/`; the PR carries the
  `migration-approved` label so the deploy pipeline applies + ledgers them (never `db push`).
- Alerting reuses the existing admin-DM mechanism (same recipient query as
  `platform_anomaly_digest`); no new edge function required — the watchdog is pure SQL + `net.http_post`
  (itself optionally via `ops_net_post` so the alert channel is self-observed).
- The external-verifier assertion (§4.7) touches `.github/**`; it ships as its **own separate commit/PR**
  so the SQL migration PR and the workflow PR can be reviewed and merged independently.
- Self-merge to `main` requires the owner's explicit "merge it" per PR — including the migration PR
  (which additionally needs the `migration-approved` label to actually apply).

## 12. Doctrine compliance (checklist)

- ✅ Reproduce & root-cause from evidence — done (§1, live prod numbers).
- ✅ Fan out the class — this covers **all** `net.http_post` callers, not just the one 403.
- ✅ Fix the class — one shared capture/classify/alert engine, not per-caller patches.
- ✅ Heal history — the 403 misconfig fix (§4.6).
- ✅ Add a detector — the watchdog + `ops_http_health()` + external-verifier assertion (fires before
  the next complaint).
- ✅ Record the lesson — auto-memory update on ship (new memory: "pg_net silent-failure class +
  6h TTL + ops_http_failures detector + kill-switch").

## 13. Open follow-ups

- **C2:** second alert channel (email/second bot); `console.error → platform_error_log` edge sweep.
- **C3:** auto-heal promotions; CI migration dry-run + broader edge tests.
- **Measure-then-tune:** once `ops_http_failures` quantifies the `:00`/`:30` timeout bursts by
  endpoint, decide whether to stagger cron schedules and/or raise timeouts on specific slow calls.
