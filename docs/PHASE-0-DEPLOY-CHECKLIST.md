# Phase 0 — Deploy & Verify Checklist

_Branch: `phase-0-security`. Six of the seven Phase 0 fixes (0.1, 0.3, 0.4, 0.5, 0.6, 0.7). 0.2 (video access enforcement) is tracked separately — see the bottom._

Local gates already passing: **`tsc --noEmit` clean · `vitest` 21/21 · `npm run check:config` passes.**
Nothing here is live until you deploy. Each fix is independently shippable.

## Files changed
**Frontend:** `src/lib/roles.ts` (new) · `src/contexts/AuthContext.tsx` · `src/pages/SalesIntake.tsx` · `src/App.tsx` · `src/test/roles.test.ts` (new)
**Edge functions:** `supabase/functions/admin-create-students/index.ts` · `bunny-sign/index.ts` · `sheet-sync/index.ts` · `staff-intake/index.ts` (new)
**DB migrations:** `20260622010000_phase0_block_self_enrollment.sql` (new) · `20260622020000_phase0_sheet_sync_rate_limit.sql` (new)
**Config / CI:** `supabase/config.toml` · `scripts/check-config-toml.mjs` (new) · `package.json` (`check:config` script)

## Deploy order
1. **Migrations** — `supabase db push` (or via Lovable). Adds the admin-only enrollment INSERT policy + the rate-limit table/function. Both additive.
2. **Edge functions** — deploy `admin-create-students`, `bunny-sign`, `sheet-sync`, and the new `staff-intake`.
3. **config.toml `verify_jwt`** — re-apply on deploy. ⚠️ Confirm `telegram-auth` and `login-guard` stay `verify_jwt = false` (they run pre-login) — then verify all logins still work.
4. **Frontend** — deploy the SPA (Vercel / Lovable Publish).
5. **Sheets** — the Google Apps Script is unchanged (still uses `x-sheet-secret`).

## Per-fix verification (run against your Supabase)
- **0.1 self-enrollment** — As a low-tier test student: `supabase.from('enrollments').insert({ user_id: <self>, course_id: <paid> })` → **rejected by RLS**. Sanity: an existing NULL-tier student still has full access (no regression — `has_module_access` is unchanged).
- **0.3 config drift** — `npm run check:config` passes. After deploy, log in via **email, Telegram, and magic-link** — all still work.
- **0.4 superadmin lockout** — Promote a throwaway user to **only** `superadmin` → they can load `/admin/*` (before this fix they were bounced to `/dashboard`).
- **0.5 admin escalation** — As a **plain admin**, try to create or promote a user with `role:"admin"` (single + CSV) → result status `forbidden`. As a **superadmin** → succeeds.
- **0.6 bunny-sign oracle** — Call `bunny-sign` with `{ mode:"verify" }` and with `{ debug:true }` → response contains **only** `{ signed_url, expires }` (no `secret_*`, no `debug`). Normal video playback still works.
- **0.7 intake** — Visit `/intake` **logged out** → redirected to `/login`. Log in as **staff** → form loads, dropdowns populate, adding a student works and writes an `admin_actions` row with `action='staff_intake'` and a real `actor_user_id`. The Google Sheet sync still works.
- **Rate limit** — >120 `sheet-sync` requests/min from one IP → `429`.

## ⚠️ Action required after deploying 0.7
**Rotate `SHEET_SYNC_SECRET`.** The old `/intake` access code *was* this secret and was exposed in browsers / localStorage. After the new staff-login intake is live, rotate the secret (update the edge-function secret **and** the Google Apps Script). The browser no longer uses it.

## Rollback
Everything is on `phase-0-security`. Migrations are additive; the enrollment policy can be reverted by recreating the previous `"enrollments insert own or admin"` policy. Note current dashboard `verify_jwt` values before re-applying config.toml.

---

## Still open: 0.2 — Video access enforcement (M05)

**Full diagnosis (after reading the whole flow):**
- `LessonPage.tsx:82` reads the lesson with `select("*")`, so the client receives `provider_video_id` / `video_url` directly.
- `lessons` RLS is `"lessons read" USING(true)` — **any** authenticated user can read those columns for **any** lesson, including locked / higher-tier modules.
- The client builds the playback URL itself for every provider: Bunny → `BunnyVideoPlayer` renders the plain `iframe.mediadelivery.net/embed/<lib>/<guid>` (it does **not** use `bunny-sign`); YouTube/Vimeo/Mux → embed URL from `provider_video_id`; upload → `video_url`.
- `lesson-video-url` (which *does* enforce `has_module_access` + `published` + enrollment) is only used as a bare-GUID **resolver**, not as the access gate.

**Net:** there is currently **no server-side access check in the real playback path** for any provider. A student can read any lesson's IDs and play locked/higher-tier videos.

**Correct fix (its own focused unit — needs a staging/branch deploy to test playback for all 5 provider types):**
1. **Route ALL playback through the gated `lesson-video-url`.** `LessonPage` stops reading `provider_video_id`/`video_url` from the table and instead calls `lesson-video-url(lessonId)`, rendering from the returned `{ url, kind }` (parse lib/guid for Bunny exactly like the existing resolver at `LessonPage.tsx:60`). This enforces access at playback for every provider.
2. **Isolate the sensitive columns** so the table read can't bypass step 1: move `video_url` / `provider_video_id` / `video_storage_path` into a `lesson_video_sources` table with staff-only RLS (`has_role`), read by the service-role functions; update the admin editor (`AdminCourseEditor`, `LessonDrawer`, `AdminBunnyDiagnostics`) to read/write the new table. (Column-level REVOKE can't work here because admins and students are both the `authenticated` role — only a separate RLS-gated table distinguishes them.)
3. **Bunny library token-auth:** confirm whether the Bunny library has token authentication enabled. If embeds are currently shareable/unsigned, enabling token-auth + routing through a signed URL is the durable lock (the now-cleaned `bunny-sign` can be repurposed for this, with a per-lesson access check added).

**Files touched:** `LessonPage.tsx`, `BunnyVideoPlayer.tsx`, `lesson-video-url`, a new migration + `lesson_video_sources` table, `AdminCourseEditor.tsx`, `LessonDrawer.tsx`, `AdminBunnyDiagnostics.tsx`. **Must be playback-tested on a deploy before going live** — this is the one Phase-0 change that can break video for all students if shipped unverified.
