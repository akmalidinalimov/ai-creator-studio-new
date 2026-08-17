# Telegram Mini App Conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students open the entire existing student app inside Telegram as a native-feeling Mini App, signed in automatically via Telegram, while the same codebase keeps working as a regular website.

**Architecture:** "One app, two doors." A boot-time `TelegramGate` detects Telegram `initData`; if present it calls a new `tg-miniapp-auth` edge function (validate initData → resolve/link profile → mint a Supabase session), calls `setSession`, and renders the *existing* app (RLS/routes/video/upload unchanged). No initData → today's web app. Everything is composition of proven code (`validateInitData`, `mintSessionForUser`, `telegram-auth`, the SDK pattern in `TgGroupBoard`).

**Tech Stack:** React 18 + Vite + TypeScript (frontend), Supabase (Postgres/RLS/Auth + Deno edge functions), Telegram WebApp JS SDK (`telegram-web-app.js`) + Bot API, i18n (uz/ru/en).

**Spec:** `docs/superpowers/specs/2026-08-15-telegram-mini-app-design.md` (read it — this plan argues from it).

## Global Constraints

- **Deploy pipeline:** commit → PR → merge; changed edge functions auto-deploy; migrations apply only with the `migration-approved` label (owner adds). Never `db push`, never manual deploy.
- **Edge fn auth:** `tg-miniapp-auth` is `verify_jwt=false` in `supabase/config.toml` (pre-session entry). All trust comes from server-side initData HMAC.
- **Auth model:** auto-link by signed `telegram_id`; username-backfill only for **`student`-role** profiles, gated by `getChatMember` on the profile's own group, **fail CLOSED**, first-link **logged + admin-DM alert** (reversible unlink).
- **Replay:** mint endpoint uses a **10-minute** initData freshness window (not 1h). **Never log `initData`.**
- **Frontend verify:** run `npm run typecheck` (tsc), not just `npm run build` (Vite skips tsc). Untyped tables/RPCs use `supabase.from("t" as any)` / `supabase.rpc("fn" as any)`.
- **Dual-mode:** web mode (no initData) must be byte-for-byte unchanged (email/password + admin panel). `isMiniApp` only *adds* behavior.
- **i18n:** any new user-facing string added to `uz.json` + `ru.json` + `en.json`.
- **Reuse, don't reimplement:** `validateInitData` (audited correct), `mintSessionForUser`, the `getChatMember` membership check, the admin-DM pattern (`badge_orphan_watchdog`/`community_xp_watchdog`).

---

## File structure

**New (backend):**
- `supabase/functions/_shared/telegram-initdata.ts` — `validateInitData()` (extracted, generalized: takes botToken + maxAgeSec; returns user + startParam).
- `supabase/functions/_shared/telegram-membership.ts` — `isChatMember(botToken, chatId, telegramId)` (Telegram `getChatMember`).
- `supabase/functions/_shared/mint-session.ts` — `mintSessionForUser(admin, email)` (extracted from `magic-link-redeem`).
- `supabase/functions/tg-miniapp-auth/index.ts` — the auth bridge.
- `supabase/functions/tg-miniapp-auth/resolve.ts` — pure `resolveProfile(deps, user)` (unit-testable).
- `supabase/functions/tg-miniapp-auth/*.test.ts` — Deno tests.
- `supabase/functions/_shared/telegram-initdata.test.ts` — Deno tests for the validator.

**Modified (backend):**
- `supabase/functions/tg-group-board/index.ts` — use the shared `validateInitData` (kill the dup).
- `supabase/functions/magic-link-redeem/index.ts` — use the shared `mintSessionForUser`.
- `supabase/config.toml` — add `tg-miniapp-auth` with `verify_jwt=false`.
- `supabase/functions/telegram-bot-webhook/index.ts` + digest/nudge functions — swap magic-link URL buttons → `web_app`/`startapp` buttons (Phase 3).

**New (frontend):**
- `src/lib/telegram/useTelegramWebApp.ts` — SDK loader/detector hook.
- `src/lib/telegram/MiniAppContext.tsx` — `{ isMiniApp, webApp }`.
- `src/lib/telegram/TelegramGate.tsx` — boot orchestration.
- `src/lib/telegram/theme.ts` — `applyTelegramTheme()`.
- `src/lib/telegram/useTelegramBackButton.ts` — BackButton → router.
- `src/lib/telegram/types.ts` — minimal `TgWebApp` typing.
- `src/pages/TgNotLinked.tsx` — the "ask your admin" gated screen.

**Modified (frontend):**
- `src/App.tsx` (or root) — wrap with `TelegramGate` / `MiniAppProvider`.
- `src/i18n/locales/{uz,ru,en}.json` — new strings.

---

## PHASE 0 — Spike (de-risk before building)

### Task 0.1: Verify video + homework upload inside the Telegram webview

Throwaway verification. No production code. Gates the "real app" claim.

- [ ] **Step 1: Stand up a temporary web_app entry.** In a **test** bot (not prod), set a menu button to a `web_app` pointing at the live site: `curl -s "https://api.telegram.org/bot<TEST_TOKEN>/setChatMenuButton" -H 'Content-Type: application/json' -d '{"menu_button":{"type":"web_app","text":"Test","web_app":{"url":"https://aicreator.academy/login"}}}'`. (Owner action — needs a test bot token.)
- [ ] **Step 2: iOS test.** Open the test bot in Telegram iOS → tap the menu button → log in → open a lesson with video → **play it** (check: inline playback, fullscreen, seek). Then open a homework task → **upload a photo** (check: camera + gallery pickers both work).
- [ ] **Step 3: Android test.** Repeat Step 2 on Telegram Android.
- [ ] **Step 4: Record findings.** Write results to `docs/superpowers/specs/2026-08-15-telegram-mini-app-design.md` under a new `## Phase 0 spike results` heading: per platform, video ✅/❌ (+ any quirk), upload ✅/❌ (+ any quirk), and mitigations if needed.
- [ ] **Step 5: Commit.** `git add docs/... && git commit -m "docs(spec): Phase 0 spike results (video + upload in Telegram webview)"`

**Gate:** if video or upload is broken on a platform, STOP and resolve (mitigation or scope note) before Phase 1. If both work, proceed.

---

## PHASE 1 — Auth core

### Task 1.1: Extract + generalize `validateInitData` into `_shared`

**Files:**
- Create: `supabase/functions/_shared/telegram-initdata.ts`
- Create: `supabase/functions/_shared/telegram-initdata.test.ts`
- Modify: `supabase/functions/tg-group-board/index.ts` (replace local `validateInitData` + `ctEq` with the import)

**Interfaces — Produces:**
```ts
export interface TgInitUser { id: number; username?: string; first_name?: string; last_name?: string; }
export interface TgInitResult { ok: boolean; user?: TgInitUser; startParam?: string; authDate?: number; }
// maxAgeSec default 3600 (board); tg-miniapp-auth passes 600.
export function validateInitData(initData: string, botToken: string, maxAgeSec?: number): Promise<TgInitResult>;
```

- [ ] **Step 1: Write the failing test.**
```ts
// supabase/functions/_shared/telegram-initdata.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateInitData } from "./telegram-initdata.ts";

const BOT = "123456:TESTTOKEN";
// Build a validly-signed initData for the test (mirror Telegram's algorithm).
async function signInitData(fields: Record<string, string>, token: string): Promise<string> {
  const enc = new TextEncoder();
  const dcs = Object.entries(fields).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([k,v]) => `${k}=${v}`).join("\n");
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(token)));
  const sk = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hash = Array.from(mac, b => b.toString(16).padStart(2,"0")).join("");
  const p = new URLSearchParams({ ...fields, hash });
  return p.toString();
}

Deno.test("valid initData → ok with user + startParam", async () => {
  const authDate = String(Math.floor(Date.now()/1000));
  const initData = await signInitData({
    user: JSON.stringify({ id: 42, username: "alice", first_name: "Alice" }),
    auth_date: authDate, start_param: "hw",
  }, BOT);
  const r = await validateInitData(initData, BOT, 600);
  assertEquals(r.ok, true);
  assertEquals(r.user?.id, 42);
  assertEquals(r.user?.username, "alice");
  assertEquals(r.startParam, "hw");
});

Deno.test("tampered hash → not ok", async () => {
  const authDate = String(Math.floor(Date.now()/1000));
  let initData = await signInitData({ user: JSON.stringify({id:1}), auth_date: authDate }, BOT);
  initData = initData.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
  assertEquals((await validateInitData(initData, BOT, 600)).ok, false);
});

Deno.test("expired auth_date → not ok", async () => {
  const old = String(Math.floor(Date.now()/1000) - 3600);
  const initData = await signInitData({ user: JSON.stringify({id:1}), auth_date: old }, BOT);
  assertEquals((await validateInitData(initData, BOT, 600)).ok, false);
});

Deno.test("wrong bot token → not ok", async () => {
  const authDate = String(Math.floor(Date.now()/1000));
  const initData = await signInitData({ user: JSON.stringify({id:1}), auth_date: authDate }, BOT);
  assertEquals((await validateInitData(initData, "999:WRONG", 600)).ok, false);
});
```
- [ ] **Step 2: Run to verify it fails.** `deno test supabase/functions/_shared/telegram-initdata.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `telegram-initdata.ts` — port the audited logic verbatim from `tg-group-board/index.ts:25-57`, parameterizing `botToken`/`maxAgeSec`, and additionally returning `user.username`, `user.first_name`, `startParam` (from `start_param`), and `authDate`:
```ts
export interface TgInitUser { id: number; username?: string; first_name?: string; last_name?: string; }
export interface TgInitResult { ok: boolean; user?: TgInitUser; startParam?: string; authDate?: number; }
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i=0;i<a.length;i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
export async function validateInitData(initData: string, botToken: string, maxAgeSec = 3600): Promise<TgInitResult> {
  if (!initData || !botToken) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash"); if (!hash) return { ok: false };
  params.delete("hash"); params.delete("signature");
  const dcs = [...params.entries()].sort(([a],[b]) => a<b?-1:a>b?1:0).map(([k,v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(botToken)));
  const sk = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2,"0")).join("");
  if (!ctEq(hex, hash)) return { ok: false };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now()/1000 - authDate > maxAgeSec) return { ok: false };
  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user?.id) return { ok: false };
    return { ok: true, authDate, startParam: params.get("start_param") || undefined,
      user: { id: Number(user.id), username: user.username, first_name: user.first_name, last_name: user.last_name } };
  } catch { return { ok: false }; }
}
```
- [ ] **Step 4: Run to verify it passes.** `deno test supabase/functions/_shared/telegram-initdata.test.ts` → PASS (4 tests).
- [ ] **Step 5: Refactor `tg-group-board`** to import `validateInitData` from `../_shared/telegram-initdata.ts` (pass `BOT_TOKEN, 3600`); delete its local copy + `ctEq`. Adjust the call site (it used `{ ok, userId }` — now `{ ok, user }`, so use `res.user?.id`).
- [ ] **Step 6: Verify no regression.** `deno check supabase/functions/tg-group-board/index.ts`. (Board behavior unchanged; same algorithm.)
- [ ] **Step 7: Commit.** `git add supabase/functions/_shared/telegram-initdata.ts supabase/functions/_shared/telegram-initdata.test.ts supabase/functions/tg-group-board/index.ts && git commit -m "refactor(tg): extract shared validateInitData (audited) + reuse in tg-group-board"`

### Task 1.2: Extract shared `mintSessionForUser` + `isChatMember`

**Files:**
- Create: `supabase/functions/_shared/mint-session.ts`
- Create: `supabase/functions/_shared/telegram-membership.ts`
- Modify: `supabase/functions/magic-link-redeem/index.ts` (use the shared mint)

**Interfaces — Produces:**
```ts
export function mintSessionForUser(admin: SupabaseClient, email: string): Promise<{ access_token: string; refresh_token: string }>;
// returns true=member, false=not a member, null=API error/unknown (caller fails CLOSED on null)
export function isChatMember(botToken: string, chatId: number|string, telegramId: number): Promise<boolean | null>;
```

- [ ] **Step 1: Implement `mint-session.ts`** — move `mintSessionForUser` verbatim from `magic-link-redeem/index.ts:12-34` (generateLink magiclink → verifyOtp with anon client → tokens). Keep the `SUPABASE_URL`/`SUPABASE_ANON_KEY` env reads inside.
- [ ] **Step 2: Refactor `magic-link-redeem`** to import it; delete the local copy. `deno check` the file.
- [ ] **Step 3: Implement `telegram-membership.ts`:**
```ts
export async function isChatMember(botToken: string, chatId: number|string, telegramId: number): Promise<boolean|null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: telegramId }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) return null; // API error, bot-not-admin, etc → caller fails closed
    const status = j.result?.status;
    return status === "creator" || status === "administrator" || status === "member" || status === "restricted";
  } catch { return null; }
}
```
- [ ] **Step 4: Commit.** `git add supabase/functions/_shared/mint-session.ts supabase/functions/_shared/telegram-membership.ts supabase/functions/magic-link-redeem/index.ts && git commit -m "refactor(auth): extract shared mintSessionForUser + isChatMember helper"`

### Task 1.3: `tg-miniapp-auth` — pure resolver (unit-testable core)

**Files:**
- Create: `supabase/functions/tg-miniapp-auth/resolve.ts`
- Create: `supabase/functions/tg-miniapp-auth/resolve.test.ts`

**Interfaces — Produces:**
```ts
export type ResolveOutcome =
  | { kind: "signin"; profileId: string; email: string; backfilled: boolean }
  | { kind: "not_linked" };
export interface ResolveDeps {
  findByTelegramId(tgId: number): Promise<{ id: string; email: string } | null>;
  findStudentUsernameOnly(username: string): Promise<{ id: string; email: string; group_id: string | null; group_chat_id: number | null } | { ambiguous: true } | null>;
  isMember(chatId: number, tgId: number): Promise<boolean | null>;
  linkTelegramId(profileId: string, tgId: number, username?: string): Promise<void>;
  alertFirstLink(profileId: string, tgId: number, username?: string): Promise<void>;
}
export function resolveProfile(deps: ResolveDeps, user: { id: number; username?: string }): Promise<ResolveOutcome>;
```

- [ ] **Step 1: Write the failing tests** (`resolve.test.ts`) with fake deps for: (a) linked telegram_id → signin no-backfill; (b) student username + member → signin backfilled + alert called; (c) student username + non-member → not_linked, no link; (d) student username + `isMember`→null (API error) → not_linked, no link (fail closed); (e) ambiguous username → not_linked; (f) no match → not_linked. (Staff-only exclusion is enforced by `findStudentUsernameOnly` returning null for staff — assert that a username that only matches a staff profile yields not_linked.)
```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveProfile, ResolveDeps } from "./resolve.ts";
const base = (): ResolveDeps => ({
  findByTelegramId: async () => null,
  findStudentUsernameOnly: async () => null,
  isMember: async () => true,
  linkTelegramId: async () => {},
  alertFirstLink: async () => {},
});
Deno.test("linked telegram_id → signin, no backfill", async () => {
  const d = { ...base(), findByTelegramId: async () => ({ id: "p1", email: "p1@telegram.local" }) };
  const r = await resolveProfile(d, { id: 1 });
  assertEquals(r, { kind: "signin", profileId: "p1", email: "p1@telegram.local", backfilled: false });
});
Deno.test("student username + member → signin backfilled + alert", async () => {
  let linked = false, alerted = false;
  const d: ResolveDeps = { ...base(),
    findStudentUsernameOnly: async () => ({ id: "p2", email: "p2@telegram.local", group_id: "g", group_chat_id: -100 }),
    isMember: async () => true,
    linkTelegramId: async () => { linked = true; }, alertFirstLink: async () => { alerted = true; } };
  const r = await resolveProfile(d, { id: 2, username: "malika" });
  assertEquals(r, { kind: "signin", profileId: "p2", email: "p2@telegram.local", backfilled: true });
  assertEquals(linked && alerted, true);
});
Deno.test("student username + non-member → not_linked, no link", async () => {
  let linked = false;
  const d: ResolveDeps = { ...base(),
    findStudentUsernameOnly: async () => ({ id: "p3", email: "e", group_id: "g", group_chat_id: -100 }),
    isMember: async () => false, linkTelegramId: async () => { linked = true; } };
  assertEquals(await resolveProfile(d, { id: 3, username: "x" }), { kind: "not_linked" });
  assertEquals(linked, false);
});
Deno.test("getChatMember error → not_linked (fail closed)", async () => {
  const d: ResolveDeps = { ...base(),
    findStudentUsernameOnly: async () => ({ id: "p4", email: "e", group_id: "g", group_chat_id: -100 }),
    isMember: async () => null };
  assertEquals(await resolveProfile(d, { id: 4, username: "x" }), { kind: "not_linked" });
});
Deno.test("ambiguous username → not_linked", async () => {
  const d: ResolveDeps = { ...base(), findStudentUsernameOnly: async () => ({ ambiguous: true }) };
  assertEquals(await resolveProfile(d, { id: 5, username: "x" }), { kind: "not_linked" });
});
Deno.test("no match → not_linked", async () => {
  assertEquals(await resolveProfile(base(), { id: 6, username: "ghost" }), { kind: "not_linked" });
});
```
- [ ] **Step 2: Run → FAIL** (`deno test supabase/functions/tg-miniapp-auth/resolve.test.ts`).
- [ ] **Step 3: Implement `resolve.ts`:**
```ts
export async function resolveProfile(deps: ResolveDeps, user: { id: number; username?: string }): Promise<ResolveOutcome> {
  const linked = await deps.findByTelegramId(user.id);
  if (linked) return { kind: "signin", profileId: linked.id, email: linked.email, backfilled: false };
  const uname = (user.username || "").replace(/^@+/, "").toLowerCase();
  if (!uname) return { kind: "not_linked" };
  const match = await deps.findStudentUsernameOnly(uname);
  if (!match || (match as any).ambiguous) return { kind: "not_linked" };
  const m = match as { id: string; email: string; group_id: string | null; group_chat_id: number | null };
  if (!m.group_chat_id) return { kind: "not_linked" };            // no group to verify against → fail closed
  const member = await deps.isMember(m.group_chat_id, user.id);
  if (member !== true) return { kind: "not_linked" };             // false OR null → fail closed
  await deps.linkTelegramId(m.id, user.id, user.username);
  await deps.alertFirstLink(m.id, user.id, user.username);
  return { kind: "signin", profileId: m.id, email: m.email, backfilled: true };
}
```
- [ ] **Step 4: Run → PASS** (6 tests).
- [ ] **Step 5: Commit.** `git add supabase/functions/tg-miniapp-auth/resolve.ts supabase/functions/tg-miniapp-auth/resolve.test.ts && git commit -m "feat(tg-miniapp-auth): pure profile resolver (student-only backfill, membership-gated, fail-closed) + tests"`

### Task 1.4: `tg-miniapp-auth` — HTTP handler wiring the deps

**Files:**
- Create: `supabase/functions/tg-miniapp-auth/index.ts`
- Modify: `supabase/config.toml` (register with `verify_jwt = false`)

**Interfaces — Consumes:** `validateInitData` (Task 1.1), `mintSessionForUser` + `isChatMember` (Task 1.2), `resolveProfile` (Task 1.3). **Produces:** `POST { initData } → { session, target_path } | { error }`.

- [ ] **Step 1: Add to `supabase/config.toml`:**
```toml
[functions.tg-miniapp-auth]
verify_jwt = false
```
- [ ] **Step 2: Implement `index.ts`** — CORS + POST; parse `{ initData }`; `validateInitData(initData, BOT_TOKEN, 600)`; on fail → 401 `{error:"invalid"|"expired"}` (distinguish by re-checking age if you want, else `invalid`). Build `ResolveDeps` from a service-role client:
  - `findByTelegramId`: `profiles` join `auth.users` on id → `{id,email}` where `telegram_id = tgId`.
  - `findStudentUsernameOnly`: profiles with `telegram_id IS NULL` AND role=`student` (join `user_roles`) AND `lower(telegram_username)=uname`; join the group to get `group_id` + its `telegram_chat_id` (latest from `group_message_events`, or a stored chat id). Return `{ambiguous:true}` if >1.
  - `isMember`: wrap `isChatMember(BOT_TOKEN, chatId, tgId)` **with a short in-memory cache** (Map keyed `chatId:tgId`, 60s TTL) to blunt abuse.
  - `linkTelegramId`: `update profiles set telegram_id, telegram_username, updated_at where id=? and telegram_id is null`; insert `admin_actions: username_link_via_miniapp`.
  - `alertFirstLink`: DM up to 3 admins (reuse the `community_xp_watchdog` DM pattern) — "🔗 <name> linked telegram_id <N> via Mini App. Not them? /unlink <profile>." (Owner-facing; localize later.)
  - On `signin` → `mintSessionForUser(admin, email)`; `target_path` from `startParam` (`hw`→`/homework`, else `/dashboard`); log `auth_events` (source `miniapp`); return `{session, target_path}`. On `not_linked` → 403 `{error:"not_linked"}`.
  - **Rate-limit:** simple per-`telegram_id` (or IP) counter (in-memory Map or an `ops_http`-style table) → 429 `{error:"rate_limited"}` past a threshold. **Never `console.log(initData)`.**
- [ ] **Step 3: Type-check.** `deno check supabase/functions/tg-miniapp-auth/index.ts`.
- [ ] **Step 4: Commit.** `git add supabase/functions/tg-miniapp-auth/index.ts supabase/config.toml && git commit -m "feat(tg-miniapp-auth): HTTP handler (10min window, membership cache, rate-limit, admin alert) + verify_jwt=false"`

> **Note:** merging this (with `config.toml` changed) deploys **all** edge functions. Land Task 1.1–1.2 refactors first or in the same PR so the shared modules exist.

### Task 1.5: Frontend — `useTelegramWebApp` + `MiniAppContext`

**Files:** Create `src/lib/telegram/types.ts`, `src/lib/telegram/useTelegramWebApp.ts`, `src/lib/telegram/MiniAppContext.tsx`.

**Interfaces — Produces:**
```ts
export function useTelegramWebApp(): { webApp: TgWebApp | null; initData: string | null | undefined; isTelegram: boolean };
// initData: undefined=loading, null=not Telegram, string=present
export function useMiniApp(): { isMiniApp: boolean; webApp: TgWebApp | null };
```

- [ ] **Step 1: `types.ts`** — minimal `TgWebApp` interface (`initData`, `ready()`, `expand()`, `expand`, `themeParams`, `colorScheme`, `viewportStableHeight`, `isVersionAtLeast(v)`, `disableVerticalSwipes?()`, `BackButton`, `onEvent`, `safeAreaInset?`).
- [ ] **Step 2: `useTelegramWebApp.ts`** — generalize `TgGroupBoard.tsx:92-113`: if `window.Telegram?.WebApp` present, poll ~20×150ms for `initData`; else inject `https://telegram.org/js/telegram-web-app.js` then poll; timeout → `initData=null`. Return `{ webApp, initData, isTelegram: initData != null }`.
- [ ] **Step 3: `MiniAppContext.tsx`** — a provider that runs the hook once and exposes `{ isMiniApp: initData != null && initData !== undefined, webApp }`; `useMiniApp()` consumer.
- [ ] **Step 4: Type-check.** `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add src/lib/telegram/ && git commit -m "feat(miniapp): Telegram WebApp detection hook + MiniAppContext"`

### Task 1.6: Frontend — `TelegramGate` boot + not-linked screen

**Files:** Create `src/lib/telegram/TelegramGate.tsx`, `src/pages/TgNotLinked.tsx`; modify `src/App.tsx`; modify the 3 i18n files.

**Interfaces — Consumes:** `useTelegramWebApp`, `supabase.auth`, `supabase.functions.invoke("tg-miniapp-auth")`.

- [ ] **Step 1: i18n** — add `miniapp.signingIn`, `miniapp.notLinkedTitle`, `miniapp.notLinkedBody`, `miniapp.retry` to `uz.json`/`ru.json`/`en.json`.
- [ ] **Step 2: `TgNotLinked.tsx`** — centered card, `t("miniapp.notLinkedTitle"/"...Body")`, no login link (auth is automatic in Telegram).
- [ ] **Step 3: `TelegramGate.tsx`** — logic:
```
const { initData } = useTelegramWebApp();
if (initData === undefined) return <Spinner/>;            // loading SDK
if (initData === null) return <>{children}</>;            // WEB MODE — untouched
// MINI APP MODE:
const { data: sess } = await supabase.auth.getSession();
if (sess?.session) {
  // cross-account guard: does the session user own this initData's telegram_id?
  const parsed = JSON.parse(new URLSearchParams(initData).get("user")||"{}");
  const okUser = await matchesTelegramId(sess.session.user.id, parsed.id); // rpc/select
  if (okUser) return <>{children}</>;                     // fast re-open
  await supabase.auth.signOut();                          // mismatch → re-auth
}
const { data, error } = await supabase.functions.invoke("tg-miniapp-auth", { body: { initData } });
if (error || data?.error === "not_linked") return <TgNotLinked/>;
if (data?.error) return <RetryScreen/>;                   // invalid/expired/rate_limited
await supabase.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
// (Phase 2 will call applyTelegramTheme/expand/back-button here)
return <>{children}</>;
```
Implement as a component with `useState` phases (`loading | web | authing | ready | notlinked | error`) and an effect running the async flow once. The cross-account check is a tiny RPC or a `profiles` select `id == session.user.id && telegram_id == parsed.id`.
- [ ] **Step 4: Wrap the app** — in `src/App.tsx`, wrap the router/root in `<MiniAppProvider><TelegramGate>…</TelegramGate></MiniAppProvider>`. Ensure web mode renders children with zero behavior change.
- [ ] **Step 5: Type-check + build.** `npm run typecheck && npm run build`.
- [ ] **Step 6: Commit.** `git add src/ && git commit -m "feat(miniapp): TelegramGate boot (initData→session, cross-account guard, not-linked screen), dual-mode preserved"`

### Task 1.7: Prod E2E with a synthetic student

- [ ] **Step 1:** After Phase 1 merges + deploys, create a synthetic student via `admin-create-students` (`x-internal-secret`) with a known `telegram_username`, in an active group.
- [ ] **Step 2:** Simulate the Mini App call: `POST /functions/v1/tg-miniapp-auth` with a validly-signed `initData` for that student's telegram_id/username (use the `signInitData` helper against the real prod `TELEGRAM_BOT_TOKEN` — owner runs this, token never leaves their env), assert `{session}` returned and the username-backfill set `telegram_id`, and the admin alert fired (`admin_actions: username_link_via_miniapp`).
- [ ] **Step 3:** Assert the resolved session reads the student's own profile (RLS) via a quick `profile_stats` call with the returned token.
- [ ] **Step 4:** DELETE the synthetic student; assert zero residue (profile, auth.users, xp_events, admin_actions rows tied to it cleaned per the verification bar).
- [ ] **Step 5:** Record the E2E result in the PR description.

---

## PHASE 2 — Native feel

### Task 2.1: `applyTelegramTheme`

**Files:** Create `src/lib/telegram/theme.ts`; call it from `TelegramGate` after auth.

- [ ] **Step 1:** Implement `applyTelegramTheme(webApp)`: read `webApp.themeParams` + `webApp.colorScheme`; convert each hex → HSL; set the app's CSS tokens on `document.documentElement.style` — map `bg_color`→`--background`, `text_color`→`--foreground`, `button_color`→`--primary`, `secondary_bg_color`→`--card`/`--muted`, `hint_color`→`--muted-foreground`, `link_color`→`--primary` (accent). Prefer Telegram's native `--tg-theme-*` vars where a 1:1 mapping is awkward. Guard: if `themeParams` empty, no-op (keep app theme).
- [ ] **Step 2:** Subscribe to `webApp.onEvent("themeChanged", () => applyTelegramTheme(webApp))`.
- [ ] **Step 3:** Type-check + manual check (open in Telegram, toggle Telegram light/dark, confirm app follows).
- [ ] **Step 4: Commit.** `git commit -m "feat(miniapp): map Telegram theme → app tokens (light/dark, live themeChanged)"`

### Task 2.2: Viewport + safe areas + swipe guard

**Files:** modify `TelegramGate.tsx` (a `useTelegramViewport(webApp)` hook in `src/lib/telegram/`).

- [ ] **Step 1:** On ready: `webApp.ready(); webApp.expand();`. Set layout root height from `viewportStableHeight` (or lean on `var(--tg-viewport-stable-height)`). Apply `safeAreaInset`/`contentSafeAreaInset` as root padding when present.
- [ ] **Step 2:** `if (webApp.isVersionAtLeast("7.7")) webApp.disableVerticalSwipes?.();` (guarded — older clients skip).
- [ ] **Step 3:** Manual check on device: full-height, no accidental close on scroll, no content under the notch.
- [ ] **Step 4: Commit.** `git commit -m "feat(miniapp): viewport expand + stable-height + safe-area + disableVerticalSwipes (version-gated)"`

### Task 2.3: Telegram BackButton → router

**Files:** Create `src/lib/telegram/useTelegramBackButton.ts`; mount inside the routed app (needs `useLocation`/`useNavigate`).

- [ ] **Step 1:** Hook: on route change, if not root (`/dashboard`) → `webApp.BackButton.show()` + `onClick(() => navigate(-1))`; on root → `webApp.BackButton.hide()`. Clean up the handler on unmount/route change.
- [ ] **Step 2:** Type-check + manual (Telegram back button pops the route; hidden on dashboard).
- [ ] **Step 3: Commit.** `git commit -m "feat(miniapp): Telegram BackButton drives router navigation"`

---

## PHASE 3 — Entry points

### Task 3.0: BotFather Mini App registration (owner action — documented)

- [ ] **Step 1:** In BotFather: `/newapp` on the prod bot → set title, short-name, description, photo, and **Web App URL = `https://aicreator.academy`**. Record the resulting `t.me/<bot>/<shortname>`.
- [ ] **Step 2:** Note the short-name in the spec/plan for the deep-link (`startapp`) construction.

### Task 3.1: Persistent menu button

**Files:** a small one-shot (script or admin edge call) using `setChatMenuButton`.

- [ ] **Step 1:** Call Bot API `setChatMenuButton` with `{ menu_button: { type: "web_app", text: "🚀 Ilovani ochish", web_app: { url: "https://aicreator.academy" } } }` (owner runs with the prod token, or a guarded admin edge fn). This sets the default menu button for all private chats.
- [ ] **Step 2:** Verify: open the bot DM → the input-bar button opens the Mini App signed-in.
- [ ] **Step 3:** Commit any script/docs. `git commit -m "chore(miniapp): set persistent web_app menu button"`

### Task 3.2: Swap in-flow magic-link buttons → web_app / startapp

**Files:** modify `supabase/functions/telegram-bot-webhook/index.ts` + the digest/nudge functions that emit magic-link buttons (`teacher-daily-digest`, `cron-teacher-engagement-nudge`, `detect-and-nudge`, etc.).

- [ ] **Step 1:** Inventory every place that builds an inline button with a `…/auth/magic?t=` URL (Grep `auth/magic` + `telegram_magic_links`).
- [ ] **Step 2:** For **private-chat** buttons: replace the URL button with a `web_app` button `{ text, web_app: { url: "https://aicreator.academy" + optional #route } }`, or a `t.me/<bot>/<app>?startapp=<param>` URL button (deep-link) where a target screen matters (`startapp=hw` → `start_param` → `/homework`). Keep the magic-link as a **fallback** only where the recipient may be on desktop web.
- [ ] **Step 3:** For **group-posted** buttons: DO NOT use `web_app` (unsupported in groups) — use `t.me/<bot>/<app>?startapp=…` URL buttons.
- [ ] **Step 4:** Verify each changed flow in a test chat (button opens the Mini App to the right screen).
- [ ] **Step 5: Commit** per function group. `git commit -m "feat(miniapp): bot flows open the Mini App (web_app/startapp) instead of magic links"`

---

## Testing summary (maps to spec §Testing)

- **Deno unit:** `telegram-initdata.test.ts` (4), `resolve.test.ts` (6). Run in CI ("Edge functions (Deno tests)").
- **Prod E2E:** Task 1.7 (synthetic student, backfill + alert + RLS read + delete-zero-residue).
- **Frontend:** `npm run typecheck` each task; manual device checks for theme/viewport/back-button/video/upload.
- **Web-mode regression:** confirm `/login` + admin panel unchanged when no initData (Task 1.6 Step 4).
- **Security cases** (in `resolve.test.ts` + E2E): staff username → not_linked; non-member → not_linked; getChatMember error → not_linked (fail closed); replay >10min → rejected (validator test with maxAge=600); first-link alert fires.

## NOT in scope (deferred)

Teacher/admin Mini App surface; MainButton/haptics/closing-confirmation; the UI redesign; auto-provisioning brand-new accounts; Telegram-native payments. (Per spec non-goals.)
