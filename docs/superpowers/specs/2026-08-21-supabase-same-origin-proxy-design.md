# Supabase same-origin proxy — design

**Status:** approved in chat 2026-08-21 (scope: Core proxy). Author: agent. Owner: product lead.

## Problem

A paid student (`@ummulfirdavs`, Premium, healthy account) cannot log in or load
courses on the web. Both failures surface as the app's own error states with the
raw message **"Load failed"** — Safari/iOS's wording for a `fetch` that never
completed a round-trip. Evidence:

- Her magic-link redeems have failed for days (every `telegram_magic_links` row
  since Aug 17 has `used_at: null`); at 12:00 even her cached session couldn't
  fetch courses.
- `magic-link-redeem` CORS is `Access-Control-Allow-Origin: *` — **not** a CORS
  block. Her account is valid.
- The platform is healthy for everyone else (19 successful redeems + active
  learners in the 3 h around her attempts).
- She loads the app shell (hosted on Vercel) fine, but **every request to the
  Supabase host `cdyidatkegxwhtuoqxly.supabase.co` fails**.

**Root cause:** her network/device cannot reach `*.supabase.co` (regional
ISP/carrier filtering or DNS/routing — common in Uzbekistan; she is already on
the `.vercel.app` fallback, i.e. the primary domain is likely filtered too),
while it *can* reach our app domain. This is invisible server-side (a blocked
request never arrives), so blast radius is unknown; if several students report
it, it is regional filtering, not a one-off.

## Goal

Make the backend reachable for any student who can load the app, by routing all
Supabase traffic through **our own (reachable) origin** instead of the client
hitting `supabase.co` directly. Same-origin also removes CORS entirely.

## Approach (chosen): same-origin reverse-proxy via Vercel rewrites, domain-agnostic

- **`vercel.json` rewrite**, ordered BEFORE the SPA catch-all:
  `{ "source": "/sb/:path*", "destination": "https://cdyidatkegxwhtuoqxly.supabase.co/:path*" }`.
  Vercel proxies method + headers + body from *its* network (never blocked) to
  Supabase. First-match-wins ordering keeps `/sb/*` from being swallowed by the
  existing `/(.*) → /index.html` fallback.
- **`src/lib/supabaseBase.ts`** (new): `export const SB_BASE = <origin>/sb`,
  computed from `window.location.origin` so it is **domain-agnostic** (works on
  `vercel.app`, the custom domain, any future domain, with no per-domain config).
  Falls back to `import.meta.env.VITE_SUPABASE_URL` when `window` is absent.
- **`src/integrations/supabase/client.ts`**: the SDK client is created with
  `SB_BASE` (so auth / rest / storage / `functions.invoke` all go through `/sb`).
- **All direct edge-function fetches** (15 sites / 11 files) switch from
  `${VITE_SUPABASE_URL}/functions/v1/...` to `${SB_BASE}/functions/v1/...`.
  `src/pages/admin/AdminDeploy.tsx` is the exception — it *displays* the env var
  value as setup documentation and must keep showing the real URL.

**Rejected alternatives:** a Supabase custom domain (`api.aicreator.academy`)
needs the Pro add-on + DNS and can still resolve to a blocked IP/TLD; a
client-side fetch interceptor rewriting `supabase.co → /sb` is fragile. The
Vercel rewrite reuses the already-reachable app origin — exactly the property we
need — and is domain-agnostic.

## Realtime (the one non-HTTP path)

supabase-js `^2.104.1` derives every service URL (auth/rest/storage/functions/
**realtime**) from the single `supabaseUrl`. A Vercel rewrite cannot upgrade a
websocket, so a realtime channel on `/sb` would silently fail to connect.

Only **one** component uses realtime — `src/components/admin/KnowledgeManager.tsx`
(`postgres_changes` live-refresh, admin-only). To avoid regressing it, add a
**dedicated realtime client** pointed at the **direct** Supabase host
(`VITE_SUPABASE_URL`) and use it for that subscription only. Admins are on
unfiltered networks, so the direct websocket connects; students never touch
realtime.

## Scope

**In (v1 — Core proxy):** auth (login, magic-link redeem, refresh), REST/data,
`functions.invoke` + all direct edge-fn fetches, storage-SDK calls, all through
`/sb`. Dedicated direct-host realtime client for the one admin subscription.

**Out (documented fast-follow):** edge functions that return **server-generated
signed URLs** (`hw-audio-url` homework audio, avatar signed URLs, etc.) still
embed the `supabase.co` host, so those specific files can still fail on a
filtered network. Homework **images** already use token-free `data:` URLs
(unaffected). Rewriting those signed URLs to `/sb/storage/...` is a follow-up.

**Out of reach entirely:** **Bunny video** is a separate CDN
(`mediadelivery.net`/`b-cdn.net`). If a network *also* blocks Bunny, video still
won't play — that would need a separate video proxy. Bunny is usually reachable
where AWS/Supabase is not, so this likely fixes the full "log in + watch" flow,
but her exact network cannot be tested from here.

## Data flow after the change

`browser → https://<app-origin>/sb/{auth,rest,storage,functions}/... → (Vercel edge rewrite) → https://cdyidatkegxwhtuoqxly.supabase.co/...`

- JWT/`apikey`/`Authorization` headers pass through unchanged.
- Session storage stays `localStorage` (unchanged) — no cookie/domain issues.
- Streaming (SSE) responses (`study-assistant`) proxy through the rewrite.

## Risks & mitigations

- **Rewrite must actually proxy POST + streaming + auth headers.** Verify on a
  Vercel **preview** deploy before prod (this is the login path). This is the
  primary gate.
- **Ordering:** `/sb/:path*` must precede the SPA catch-all in `vercel.json`.
- **Latency/bandwidth:** one extra hop through Vercel's edge (rewrite, not a
  serverless function → no per-request compute cost, only bandwidth). Acceptable
  for a course platform's mostly-small JSON.
- **Security:** no new surface — the anon key is already public; the rewrite is a
  dumb pass-through to a host the browser could already reach directly.
- **`client.ts` header** says "automatically generated, do not edit directly."
  We own the repo; edit it and keep the change minimal + commented (regeneration
  is manual and rare).

## Verification bar

- `npm run typecheck` + `npm run build` clean.
- **Preview deploy** (push branch → Vercel preview): confirm through `/sb`, on
  the preview origin, that (a) login works (password + magic-link redeem),
  (b) courses/lessons data loads, (c) a streaming edge fn (`study-assistant`)
  streams, (d) a normal edge fn (`login-guard`) responds. Confirm the browser
  Network tab shows requests to `<origin>/sb/...`, not `supabase.co`.
- Admin realtime (KnowledgeManager) still receives live updates via the direct
  client.
- Only after preview verification: open PR; merge on the owner's explicit
  "merge it".

## Global constraints

Isolated branch; never merge to `main` without the owner's explicit "merge it".
No migration files (this is frontend + config only → no `migration-approved`
label). Never `git add -A` (dirty `.env`/`deno.lock`/`scripts/`). Never
log/commit/return secrets. Frontend verified by `typecheck` (tsc), not just
`build`. Dark/mobile-first conventions unaffected (no UI changes).
