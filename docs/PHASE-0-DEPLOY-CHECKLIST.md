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
**Corrected diagnosis:** the lesson video IDs are *already* sent to the browser for legitimate playback (`LessonPage.tsx:82` selects `*`), so hiding the column alone doesn't fix it. The real hole is that **`bunny-sign` signs any `video_guid` for any authenticated user with no module-access check** — so a student can obtain a playable URL for a locked/higher-tier video. The fix:
1. Make `bunny-sign` resolve the lesson and enforce `has_module_access` + `published` + enrollment (mirroring `lesson-video-url`) before signing.
2. Route non-Bunny providers (YouTube/Vimeo/Mux) through the already-gated `lesson-video-url`, and stop relying on the client reading raw IDs from `lessons` for access decisions.
3. Optionally move `video_url`/`provider_video_id`/`video_storage_path` to a staff-only table for defense-in-depth.

This touches `bunny-sign`, `lesson-video-url`, `BunnyVideoPlayer`, and `LessonPage`, and must be tested on the live DB — so it is its own focused unit, not bundled here.
