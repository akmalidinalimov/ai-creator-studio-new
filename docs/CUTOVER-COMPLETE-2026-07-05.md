# Cutover complete — 2026-07-05

The platform now runs entirely on the owner's own Supabase (**ACADEMY**,
ref `cdyidatkegxwhtuoqxly`), served via **Vercel** at **aicreator.academy**.
The old Lovable-managed backend (`wpdztrijasgmxgliwddr`) is frozen and kept as
rollback.

## Architecture now

- **Frontend:** repo `ai-creator-studio-new` → Vercel project `ai-creator-studio-new`
  → domains `aicreator.academy` (307→www) + `www.aicreator.academy`. Auto-deploys
  on push to `main`.
- **Backend:** Supabase ACADEMY `cdyidatkegxwhtuoqxly` (eu-west-1). 61 tables,
  37 edge functions, 15 cron jobs, RLS, 60-day chat retention.
- **Telegram bot** `@aicreatorsdarsliklari_bot`: webhook → ACADEMY
  `telegram-bot-webhook`.
- **Video:** Bunny Stream library `646745`. Allowed referrers include
  `aicreator.academy`, `*.vercel.app`. `SITE_URL=https://aicreator.academy`.

## Migration facts

- 558 students migrated (539 with password hashes; 538 email + 21 Google
  identities; Telegram login maps onto email accounts).
- Auth fix required post-load: migrated `auth.users` had NULL `instance_id` +
  NULL token columns → GoTrue couldn't find/authenticate them. Fixed (see
  `migrations/20260705120000_migrated_auth_users_normalize.sql`).
- All 15 cron jobs restored to ACADEMY URLs, authenticating via a Vault-stored
  service key (`public.cron_service_key()`) + `public.internal_fn_secret()`.

## Known follow-ups

- **`weekly-digest`** (cron Sun 13:00 UTC) and **`generate-module-share-image`**
  still reference `LOVABLE_API_KEY` / `TELEGRAM_API_KEY`, which are NOT set on
  ACADEMY. Either set those values (copy from Lovable) or repoint the two
  functions to OpenAI + the direct Telegram bot API.
- **Homework "duplicate"** reported by owner: no data corruption found
  (assignments/enrollments/submissions all unique; 4.0 and 5.0 are distinct
  courses). It is a view-specific display issue — needs the exact page to fix.
- Owner to: rotate the Supabase access token + DB passwords; delete the
  `migration-export` function from the old backend; enable PITR on ACADEMY;
  post the student re-login notice.

## Rollback (if ever needed)

In Vercel, move `aicreator.academy` + `www` back to the old project (which points
at `wpdztrijasgmxgliwddr`), and re-point the Telegram webhook to the old backend.
Near-instant; old backend is frozen and intact.
