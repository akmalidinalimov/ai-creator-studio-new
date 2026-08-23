# Client error / health beacon — design

**Status:** approved in chat 2026-08-23 (owner: "create spec and start building step by step").
Author: agent.

## Problem / goal

Every incident this session (chunk-load loop, backend-unreachable "Load failed", video reload/logout,
watch-gate false completions) was found only after a **student complained** — never proactively. The
reliability architecture (triggers → reconcilers → watchdogs → out-of-band GitHub verifier) has **no
client-tier signal**: browser crashes, failed backend fetches, 404'd lazy chunks, and video-player
failures happen in the browser and leave **no server-side trace**.

Goal: add the missing leg — a lightweight **client error/health beacon** that reports browser-side
failures into a DB table a watchdog reads, so client failures become DB-visible and alertable
*before* the next complaint. Directly targets "silent errors" + "student video-watch issues".

## Key design decision — transport (why it works even when the backend is "unreachable")

The beacon POSTs to **`/sb/functions/v1/client-beacon`** (the same-origin Vercel rewrite → Supabase,
shipped in [[supabase-same-origin-proxy]] PR #102). The client can always reach the app's own origin
if the app loaded; Vercel then forwards to Supabase from *its* network. So the beacon lands even in the
exact case that is otherwise invisible — a client whose network can't reach `supabase.co` directly.
No new Vercel serverless function is needed; we reuse `/sb`.

- Transport = `fetch(..., { method:'POST', keepalive:true, headers:{ apikey, 'content-type' } })`.
  `keepalive:true` (not `navigator.sendBeacon`, which can't set the `apikey` header Kong requires)
  lets the beacon complete even if the page is about to reload (chunk-recovery) or navigate away.
- Fire-and-forget: the beacon NEVER throws and NEVER blocks the UI. A beacon failure is swallowed.

## Components

### 1. Table `public.client_error_events`
Columns: `id uuid pk`, `created_at timestamptz default now()`, `event_type text` (enum-ish:
`chunk_load` | `render_crash` | `unhandled_error` | `unhandled_rejection` | `backend_unreachable` |
`video_error` | `other`), `message text` (capped ~500 chars), `route text` (capped), `user_id uuid`
(nullable — anon allowed), `session_id text` (client-generated, capped), `app_version text` (build id,
if available), `user_agent text` (capped ~300), `extra jsonb` (capped, no secrets). Index on
`(created_at)` and `(event_type, created_at)`.
- **RLS:** enable; **admin-read only** (`has_role(auth.uid(),'admin')`); no anon/authenticated read;
  inserts happen ONLY via the edge function (service role bypasses RLS). Never PostgREST-writable.

### 2. Edge function `client-beacon` (`verify_jwt = false`)
- Accepts `POST { event_type, message, route, session_id, app_version, extra }`. Auth: none required
  (a logged-out user's login failure must still beacon); resolves `user_id` from the JWT **if present**
  (best-effort), else null.
- **Validation + caps:** whitelist `event_type`; truncate `message`/`route`/`user_agent`/`session_id`;
  strip/deny obviously-sensitive keys in `extra` (never store tokens/initData/passwords). Reject
  oversized bodies.
- **Rate-limit / anti-abuse (anon endpoint):** cheap dedup — skip if the same `(session_id, event_type,
  left(message,120))` was inserted in the last N minutes; plus a global insert cap per minute
  (shed load if flooded). Always returns `200` (never signals the client to retry).
- Inserts via service role. Emits nothing else (the watchdog does the alerting).
- Registered in `supabase/config.toml` with `verify_jwt = false`.

### 3. Client beacon module `src/lib/beacon.ts`
- `reportClientError({ type, message, route?, extra? })` — builds the payload (adds a persisted
  `session_id` from `localStorage`, the app build id, `navigator.userAgent`), **client-side throttle**
  (dedupe identical `(type, message)` within ~60s; hard cap N beacons/session to avoid a crash-loop
  flooding), and `fetch` keepalive to `${SB_BASE}/functions/v1/client-beacon` with the publishable
  `apikey`. Wrapped so it can never throw.
- No PII beyond what's already public (anon key). Message is a short error string, not a stack dump.

### 4. Wire the beacon into the real failure points (all already exist in the codebase)
- `src/components/ErrorBoundary.tsx` `componentDidCatch` → `render_crash` (or `chunk_load` when
  `isChunkLoadError`).
- `src/main.tsx` `vite:preloadError` handler + `src/lib/chunkReload.ts` (before the cache-bust reload)
  → `chunk_load`.
- A new global handler in `main.tsx`: `window.addEventListener('error' | 'unhandledrejection')` →
  `unhandled_error` / `unhandled_rejection` (deduped; ignore benign/extension noise).
- The backend "Load failed" class: a small helper `isNetworkFailure(err)` used in the existing catch
  sites (`AuthMagicLink`, `Login`, `LessonPage` study-assistant, and the Supabase client's global
  fetch failures) → `backend_unreachable`. (Optionally wrap the Supabase client `fetch` to beacon on a
  rejected request — highest coverage, lowest effort.)
- `src/components/BunnyVideoPlayer.tsx` player.js load-failure path → `video_error`.

### 5. Watchdog `client_error_watchdog()` + daily/hourly cron
- Counts client errors in the last hour, grouped by `event_type` (and top routes / distinct users).
  Alarm if any bucket exceeds a tunable threshold (e.g. `chunk_load` or `backend_unreachable` > 10
  distinct users/hr, or `render_crash` > 5). Modeled on `enrollment_watchdog`: `app_settings` state,
  daily/hourly throttle, DM up to 3 admins with the breakdown, write an `admin_actions`
  `client_error_report` row every run (positive "quiet" evidence when clean). Detect-only.
  `revoke/grant` to service_role; house cron pattern; deploy self-test.
- **Prune cron** (`prune_client_error_events`, daily): delete rows older than 30 days (bounded growth,
  like `prune_ops_http_observability`).

## Out of scope (v1)
Full session-replay / RUM, performance metrics, sampling infrastructure, a client SDK. This is
error/health signals only. Point-misallocation is already covered by `xp_award_integrity_watchdog`
(a separate, shipped piece); the beacon is about *client* failures.

## Reliability / safety constraints
- The beacon must be **strictly best-effort**: no throw, no block, no UI impact, no infinite beacon
  loop (client throttle + server dedup + global cap).
- No secrets ever leave the client (no bot token, no `initData`, no access token in `extra`).
- Same-origin `/sb` transport so it works on filtered networks.
- Migration reviewed by migration-safety + (light) xp-integrity is N/A; edge fn deno-checked; frontend
  verified by `npm run typecheck` + `build`. Migration needs the `migration-approved` label; merge on
  the owner's "merge it".

## Build order (step by step)
1. Migration: `client_error_events` table (+ RLS) + `client_error_watchdog()` + prune + crons.
2. Edge function `client-beacon` (+ config.toml `verify_jwt=false`).
3. Client `src/lib/beacon.ts` (+ unit test for throttle/dedupe).
4. Wire the six failure points.
5. Verify: typecheck/build/deno check; E2E on a preview (trigger a chunk error / a fake beacon → row
   appears; watchdog self-test clean); then PR.

## Verification bar
- A synthetic beacon (curl `/sb/functions/v1/client-beacon`) inserts exactly one capped row; a second
  identical one within the window is deduped. Oversized/garbage payloads are rejected, endpoint still
  returns 200.
- A forced client error in a preview build produces a `client_error_events` row with the right
  `event_type` + route, and no token/PII in `extra`.
- `client_error_watchdog()` runs clean at deploy (self-test), reports a "quiet" `admin_actions` row.
- No regression: `typecheck` + `build` clean; the app behaves identically when the beacon endpoint is
  unreachable (beacon silently no-ops).
