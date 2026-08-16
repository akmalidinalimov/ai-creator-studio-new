# Telegram Mini App Conversion — Design Spec

**Date:** 2026-08-15
**Status:** Approved design → ready for implementation plan
**Author:** brainstormed with the owner (superpowers:brainstorming, architectural path)

## Goal

Let students open the **entire existing AI Creators student app inside Telegram as a native-feeling
Mini App** — signed in automatically via Telegram (no password, no magic link) — while the same
codebase continues to work unchanged as a regular website (email/password, admin panel). "Everything,
every rule" is inherited, not rebuilt: once a Telegram-acquired Supabase session exists, the current
app (lessons, **video**, homework upload, profile, leaderboard, tiers, RLS, edge functions) runs as-is.

## Non-goals (v1)

- Teacher/admin tools as a Mini App (students only; admins/teachers keep the web + existing group-board
  mini app).
- MainButton, haptics, closing-confirmation, biometrics, cloud storage (fast-follow polish).
- The **UI redesign** — a separate project that sits *on top of* this frame, done after.
- Auto-provisioning brand-new accounts (chosen model: auto-link existing, else "ask your admin").
- Telegram-native payments (payment stays external per current platform rule).

## Success criteria

1. A student taps the bot menu button (or an in-flow button) → the app opens inside Telegram and they
   are **signed in within ~1–2s, no magic link**, landing on their dashboard (or a deep-linked screen).
2. Their ~70% "never logged in" username-only profiles get **auto-linked** on first open (securely).
3. It **feels like a real app**: full-height, Telegram-themed (light/dark), Telegram's back button drives
   navigation; video plays and homework photo upload works.
4. **Web mode is untouched** — email/password login + admin panel behave exactly as today.
5. Every existing rule (membership gates, XP, opt-outs, RLS) still enforced (by construction).

---

## Current state (what already exists — this conversion is mostly composition)

- **initData validation** — `supabase/functions/tg-group-board/index.ts` `validateInitData()`: HMAC-SHA256
  with secret = `HMAC("WebAppData", bot_token)`, `hash = HMAC(secret, data_check_string)`, 1h freshness.
  Proven in prod for the group-board mini app.
- **Telegram identity → profile** — `supabase/functions/telegram-auth/index.ts`: matches profile by
  `telegram_id` (primary), else by `telegram_username` among `telegram_id IS NULL` profiles, backfills
  `telegram_id`.
- **Server-side session minting** — `supabase/functions/magic-link-redeem/index.ts`
  `mintSessionForUser(admin, email)`: `admin.auth.admin.generateLink({type:"magiclink"})` → `hashed_token`
  → `anonClient.auth.verifyOtp({type:"magiclink", token_hash})` → `{access_token, refresh_token}`.
  Frontend then calls `supabase.auth.setSession(...)` (see `src/pages/AuthMagicLink.tsx`).
- **WebApp SDK usage** — `src/pages/TgGroupBoard.tsx` + `TgBroadcast.tsx`: inject
  `https://telegram.org/js/telegram-web-app.js`, poll for `window.Telegram.WebApp.initData`, call
  `ready()`/`expand()`.
- **Auth context** — `src/contexts/AuthContext.tsx` + `src/pages/Login.tsx` drive the web session; RLS is
  keyed to `auth.uid()` throughout.

**Eng-review verifications (2026-08-15):**
- ✅ **Every student (670/670) has an `auth.users` email** (synthetic `@telegram.local`) → the
  `generateLink → verifyOtp` mint path works for all, incl. the 111 username-only profiles. Proven: the
  same path already runs in prod via `magic-link-redeem`. (35 have unconfirmed emails — already handled.)
- **DRY:** extract `validateInitData` to `_shared/telegram-initdata.ts` **and refactor `tg-group-board` to
  consume it** (don't leave two copies of the HMAC logic).

---

## Architecture: "one app, two doors"

Single React/Vite app, single Vercel deploy. A thin **TelegramGate** runs at app boot, before the authed
app renders:

```
boot
 └─ detect window.Telegram.WebApp.initData  (inject telegram-web-app.js; poll ~20×150ms)
     ├─ absent  → WEB MODE: render app exactly as today (AuthContext, /login, admin panel)
     └─ present → MINI APP MODE:
          ├─ valid Supabase session already in storage?  → yes: go straight in (fast re-open)
          ├─ else POST initData → tg-miniapp-auth
          │     ├─ { session } → supabase.auth.setSession() → in
          │     └─ { error:"not_linked" } → friendly "ask your admin" screen
          ├─ applyTelegramTheme(themeParams, colorScheme); listen themeChanged
          ├─ ready(); expand(); layout off viewportStableHeight; disableVerticalSwipes (if ≥7.7)
          └─ wire BackButton → router
```

Downstream, **nothing changes** — the same routes/RLS/edge functions/video player. `isMiniApp` only
*adds* behavior; it never forks the data layer.

### Component units (each small, one purpose, testable in isolation)

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| `validateInitData()` | `supabase/functions/_shared/telegram-initdata.ts` (extracted) | Verify HMAC + freshness → `{ ok, user:{id,username,first_name}, startParam }` | bot token |
| `tg-miniapp-auth` | `supabase/functions/tg-miniapp-auth/index.ts` (new) | initData → resolve/link profile (gated) → mint session | shared validator, `mintSessionForUser`, `getChatMember` membership check |
| `useTelegramWebApp()` | `src/lib/telegram/useTelegramWebApp.ts` (new; generalize TgGroupBoard detection) | Load SDK, expose `{ webApp, initData, isTelegram, isReady }` | telegram-web-app.js |
| `TelegramGate` | `src/lib/telegram/TelegramGate.tsx` (new) | Orchestrate the boot flow; render spinner / not-linked / app | hook, supabase auth, auth fn |
| `MiniAppContext` | `src/lib/telegram/MiniAppContext.tsx` (new) | Expose `{ isMiniApp, webApp }` to the tree | — |
| `applyTelegramTheme()` | `src/lib/telegram/theme.ts` (new) | Map `themeParams` (hex) → app HSL CSS tokens; honor `colorScheme` | — |
| `useTelegramBackButton()` | `src/lib/telegram/useTelegramBackButton.ts` (new) | Show BackButton off-root; drive router back | react-router, webApp |

---

## Auth bridge — `tg-miniapp-auth` (the only real new backend)

**Contract.** `POST { initData: string }` →
- `200 { session: { access_token, refresh_token }, target_path: string }`
- `403 { error: "not_linked" }` (generic — never reveals whether a username exists)
- `401 { error: "invalid" | "expired" }`

**Algorithm.**
1. `validateInitData(initData, BOT_TOKEN, maxAgeSec=3600)`. Fail → `invalid`/`expired`. Yields the
   **signed** `telegram_id`, `username`, `first_name`, and `startParam`.
2. Resolve profile:
   - **By `telegram_id`** (already linked) → **sign in directly. No gate** (signed id = proof of ownership;
     nothing squattable).
   - **Else by `username`** among **`student`-role** profiles with `telegram_id IS NULL` (**staff profiles
     — teacher/admin/superadmin — are NEVER auto-linked by username**; squatting a staff account would be
     privilege escalation — *cso Finding 2*):
     - exactly one match → **membership gate**: the matched profile already has a `group_id`, so verify the
       `telegram_id` is a member of **that profile's own group's chat** via a **single** `getChatMember`
       call (bot must be admin there). Member → backfill `telegram_id` (+ `telegram_username`); **log +
       DM an admin a reversible "X linked telegram_id N — not them? tap to unlink" alert** (*cso Finding 1*:
       the gate checks membership, not identity, so a co-member who renames to the victim's username could
       claim an unlinked profile — a narrow window, now detectable + reversible). Sign in. **`getChatMember`
       error or non-member → `not_linked` (fail CLOSED — never fail-open).**
     - zero or multiple matches → `not_linked` (log ambiguity if >1).
   - **Else** → `not_linked`.
3. Sign in = `mintSessionForUser(admin, user.email)`; `target_path` = map `startParam` → route (e.g.
   `hw` → `/homework`, else `/dashboard`). Log `auth_events` (login, source=`miniapp`).

**Deploys** via the autonomous pipeline (changed edge function). Least-privilege template
(`new-edge-function` skill at build time). `verify_jwt=false` (it's the pre-session entry), but every
input is HMAC-validated server-side.

---

## Frontend bootstrap

- `useTelegramWebApp()` — generalize the TgGroupBoard pattern (inject SDK if absent, poll for `initData`,
  call `webApp.ready()`). Returns `isTelegram=false` after timeout → web mode.
- `TelegramGate` (wraps `<App/>` at the root, above the router or just inside it):
  - web mode → render children unchanged.
  - mini app mode → if `supabase.auth.getSession()` returns a live session, **verify its user matches the
    current `initData` telegram_id's profile** (`session.user.id === profile.id`); match → render
    immediately (fast re-open); **mismatch → `signOut()` then re-auth** (prevents cross-account session
    bleed on a shared device or Telegram account-switch). No session → call
    `supabase.functions.invoke("tg-miniapp-auth", { body: { initData } })` → on session, `setSession()`
    then render; on `not_linked`, render the gated screen; on error, retryable error screen.
  - After session established: `applyTelegramTheme`, `expand`, viewport, back-button wiring.
- `MiniAppContext.isMiniApp` lets specific components adapt (e.g., the `/login` route auto-redirects into
  the gate when opened with initData; web `/login` unchanged).

**Session persistence & refresh.** `setSession` persists in the Telegram webview's localStorage; the
Supabase client auto-refreshes via its **refresh token — this is the PRIMARY mechanism and needs no
initData**. Do NOT build silent-re-auth on initData: its `auth_date` goes stale after the 1h freshness
window on a long-open app, so re-validating it would fail. initData re-auth is only a **cold-open
fallback** (fresh launch) for when no valid refresh token exists.

---

## Theme · viewport · back button (native feel, v1)

- **Theme** (`applyTelegramTheme`): read `webApp.themeParams` + `webApp.colorScheme`. Convert the hex
  values to HSL and set the app's design tokens (`--background` ← `bg_color`, `--foreground` ←
  `text_color`, `--primary` ← `button_color`, `--card` ← `secondary_bg_color`, `--muted-foreground` ←
  `hint_color`, etc.). Re-apply on the `themeChanged` event. Absent params → keep the app's own theme.
  *(Telegram also exposes `--tg-theme-*` and `--tg-viewport-stable-height` CSS vars directly; we can lean
  on those where convenient.)*
- **Viewport:** `ready()`, `expand()`; layout height from `viewportStableHeight` /
  `var(--tg-viewport-stable-height)` (avoid `100vh`); apply `safeAreaInset` / `contentSafeAreaInset` as
  padding; call `disableVerticalSwipes()` **guarded by `webApp.isVersionAtLeast("7.7")`** so scroll can't
  accidentally close the app.
- **Back button:** `useTelegramBackButton` — on non-root routes `webApp.BackButton.show()` +
  `onClick(() => navigate(-1))`; hide on the dashboard/root. Native, expected behavior.

All version-gated calls guarded with `isVersionAtLeast(...)`; older clients degrade gracefully.

---

## Entry points

- **BotFather (owner, one-time prerequisite):** register a Mini App on the bot → `t.me/<bot>/<app>`
  resolves and can be used as the menu button + deep-link target.
- **Menu button:** call Bot API `setChatMenuButton` with a `web_app` pointing at the app URL — a
  persistent "🚀 Ilovani ochish" button in the bot DM's input bar (one-time; via a small setup call).
- **In-flow buttons:** replace the current magic-link **URL** buttons with **`web_app`** buttons in
  **private-chat** bot flows and the digest/nudge functions that currently generate magic links
  (`telegram-bot-webhook`, teacher/admin digests, nudges). Deep-link via `web_app` URL's `startapp` →
  arrives as `start_param` in initData → `target_path`.
- **Caveat (baked in):** `web_app` inline buttons work **only in private chats, not in group keyboards**.
  Any group-posted buttons must remain `t.me/<bot>/<app>?startapp=…` **direct Mini App links** (or URL
  buttons), not `web_app` buttons. The magic-link flow also stays as a **fallback** for non-Telegram/web.

---

## Error handling / edge cases

| Case | Behavior |
|---|---|
| Not in Telegram (no initData after timeout) | Web mode (normal site). |
| initData invalid/expired HMAC | `invalid`/`expired` → retryable error screen ("reopen from the bot"). |
| `not_linked` (unknown / username no-membership / ambiguous) | Friendly "ask your admin to add you" screen; generic (no info leak). |
| Telegram JS fails to load | Fall back to web mode (or error screen if launched as mini app). |
| Session exists but expired; refresh fails | Silent re-auth via initData. |
| Teacher/admin opens the Mini App | Authenticated normally; the app renders their **role-appropriate view** (same as web) inside the Telegram frame — not broken, just not a v1 polish target. "Students only" means v1 *designs/tests for* the student surface, not that others are blocked. |
| Old Telegram client (missing version-gated features) | Guarded by `isVersionAtLeast`; core auth + theme still work. |

---

## Security

- initData HMAC + freshness validated **server-side only**; never trust client-parsed `initDataUnsafe`.
- **Username-backfill gated behind active-group membership** (`getChatMember`) — mitigates the squatting/
  account-takeover class flagged in CLAUDE.md; `telegram_id` direct sign-in needs no gate.
- Generic `not_linked` (don't reveal whether a username/profile exists).
- Session minted only for the **owner** of the signed `telegram_id`; impersonation path unaffected.
- `tg-miniapp-auth` is a **public** (`verify_jwt=false`) endpoint — HMAC is the sole guard, so: **constant-
  time compare** (repo's `ctEq` ✓), **rate-limit** per source/telegram_id, and **fail CLOSED** on any
  validation/membership error. Forging initData requires the bot-token secret (Telegram-only), so it can't
  mint for arbitrary users.
- **Bot-token rotation:** rotating `TELEGRAM_BOT_TOKEN` invalidates in-flight initData validation — plan a
  rotation runbook (both old+new accepted briefly, or a maintenance window).
- Auth logged to `auth_events` / `admin_actions`.
- Consistent with the member-forgiveness + trust-boundary doctrine.

**`/cso` threat-model results (2026-08-15) — folded in:**
- ✅ **`validateInitData` audited and correct** — Telegram HMAC (`secret=HMAC("WebAppData",token)`,
  `hash=HMAC(secret,data_check_string)`), sorted `\n`-joined data-check-string (`hash`+`signature`
  stripped), constant-time `ctEq`, 1h freshness. **Reuse it (extract to `_shared`); do NOT reimplement.**
- **Finding 1 — username-squatting takeover** (HIGH): the membership gate checks membership, not identity →
  a co-member who renames to a victim's username could claim an unlinked profile. **Decision: keep
  username-backfill + harden** (staff-excluded, first-link admin alert + reversible unlink, logged). Narrow
  and now detectable/recoverable.
- **Finding 2 — staff-role EoP** (HIGH): username-backfill links **`student` profiles only** (above).
- **Finding 3 — initData replay** (MED-HIGH): freshness ≠ one-time-use → replayable in-window. **Use a
  shorter freshness window on this mint endpoint (~10 min, vs the board's 1h), NEVER log initData**, and
  (optional) a replay cache keyed on `auth_date`+user.
- **Finding 4 — getChatMember abuse** (MED): the public endpoint fires a Telegram API call per backfill →
  **rate-limit per source/telegram_id AND cache membership results briefly** (protects the bot's Telegram
  rate limit + function quota).
- Appendix (accepted for v1): the getChatMember path is slower → a timing side-channel can infer a username
  exists. Low impact.

---

## Phasing (each ships value; testable independently)

- **Phase 0 — Spike (first, cheap):** verify **video playback** (Bunny player) + **homework photo upload**
  in the Telegram in-app browser on **iOS + Android**. Gates the "real app" claim. Owner can test on a
  phone with a throwaway link; record mitigations if any quirk (e.g., iOS fullscreen video, camera
  file-picker).
- **Phase 1 — Core auth:** `_shared/telegram-initdata.ts` + `tg-miniapp-auth` + `useTelegramWebApp` +
  `TelegramGate` + `setSession` + not-linked screen. Outcome: open Mini App → signed in → full app works.
- **Phase 2 — Native feel:** `applyTelegramTheme` + `themeChanged`, viewport (expand/stable-height/safe
  areas/disable-swipes), `useTelegramBackButton`.
- **Phase 3 — Entry points:** BotFather registration (owner) + `setChatMenuButton` + swap magic-link
  buttons → `web_app` / `startapp` deep-links across bot flows.

---

## Testing

- **Auth bridge (unit/integration):** linked `telegram_id`; username + member (backfill+sign-in); username
  + non-member (`not_linked`); username + `getChatMember` **error** (`not_linked`, fail-closed); unknown
  (`not_linked`); ambiguous username; bad HMAC; expired `auth_date`; **unconfirmed-email profile still
  mints** (the 35-user case); **staff-role username → `not_linked`** (cso F2); **replay of a stale (>10min)
  initData → rejected** (cso F3); **first-time backfill fires the admin alert** (cso F1).
- **Frontend:** stored-session **telegram_id mismatch → signOut + re-auth** (cross-account); cold-open with
  stale (>1h) initData relies on Supabase refresh, not initData.
- **Prod E2E** (per the platform verification bar): create a synthetic student via `admin-create-students`
  (`x-internal-secret`), run the Mini App open flow end-to-end, assert sign-in + a data read, DELETE the
  student, assert zero residue.
- **Web-mode regression:** email/password login + admin panel unaffected (same deploy).
- **Native feel:** theme light/dark, back-button navigation, full-height, video + upload on real devices
  (Phase 0 results).

---

## Prerequisites / owner actions

1. **BotFather:** create the Mini App (name + short-name) on the production bot, pointing at the app URL.
2. Decide the Mini App short-name / launch URL (prod domain — `aicreator.academy`).
3. Phase 0 device testing (video + upload) — owner's phone is the fastest path.

## Open questions (none blocking; resolve during planning)

- Exact hex→HSL token mapping for theming (Phase 2 detail; the coming UI redesign will refine it anyway).
- Whether to also point the menu button at a deep-linked landing (dashboard) vs. last-visited route.
