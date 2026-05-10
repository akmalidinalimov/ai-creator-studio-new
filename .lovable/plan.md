## Why students get "logged out" in the Telegram bot

I traced the full login path for the bot → website handoff. Here is what controls "how long a student stays signed in" today, and where the 7-day expectation breaks.

### Two independent timers are involved

1. **Supabase session (browser localStorage)** — created by `supabase.auth.setSession()` after a magic-link redeem. The web client (`src/integrations/supabase/client.ts`) already uses `persistSession: true` and `autoRefreshToken: true`, but the **server-side refresh-token inactivity timeout** has never been set, so it falls back to the project default. That default is short on this project, which is why a student who logged in 1–2 days ago gets bounced.

2. **Telegram magic-link token** — created by the bot (`createMagicLink` in `supabase/functions/telegram-bot-webhook/index.ts`) and stored in the `telegram_magic_links` table. The migration sets:
   ```
   expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
   ```
   Every "Watch the video" / "Open lesson" / "Open dashboard" button in a bot message is a URL of the form `SITE_URL/auth/magic?t=<token>`. After **10 minutes** that token is dead.
   When a student taps a button from yesterday's message, `magic-link-redeem` returns `expired`, and `AuthMagicLink.tsx` shows the "invalid / sign in again" screen. That is the "logged out" message students are seeing — it is not really their session that died, it is the **button** that died.

3. Telegram's in-app browser also tends to wipe localStorage between sessions, so even when the underlying Supabase session is still alive, opening a fresh in-app browser starts with no session and falls back to the magic-link flow. If that magic-link is expired (point 2), the student sees the logged-out screen.

### Goal

Students should not be re-prompted to sign in for **7 days** after their last successful authentication, whether they come back through the website directly or through any "Open … " button the bot has ever sent them.

---

## Plan

### 1. Extend the Supabase session lifetime to 7 days

Configure the project's Auth settings server-side so the refresh token survives at least 7 days of inactivity (and the rolling session lifetime is comfortably longer):

- `refresh_token_rotation_enabled = true` (keep current)
- `security_refresh_token_reuse_interval = 10` seconds (keep current)
- `sessions.timebox = 30 days` (rolling session ceiling)
- `sessions.inactivity_timeout = 7 days` (the missing piece)
- JWT access-token expiry stays at 3600 s (auto-refreshed by the client)

Done via the Supabase Management API (the `configure_auth` tool does not expose these fields, so this will be a one-time PATCH to `/v1/projects/<ref>/config/auth`).

### 2. Make Telegram bot buttons survive 7 days

In the migration for `telegram_magic_links`, change the column default and backfill:

```sql
ALTER TABLE public.telegram_magic_links
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');
```

In `supabase/functions/telegram-bot-webhook/index.ts → createMagicLink`:
- Extend the "reuse existing link" window from 5 minutes to the full 7 days for the same `(user_id, purpose, target_path)` so we do not flood the table.
- Explicitly set `expires_at = now() + 7 days` on insert (don't rely solely on the default, makes the intent obvious in code).

This means every button the bot has ever sent stays clickable for a week.

### 3. Graceful fallback when a magic-link token is truly expired

In `supabase/functions/magic-link-redeem/index.ts`, when a token is `used` or `expired`:
- Instead of returning a hard `410`, look up the bound `user_id` and (if the token is older than 7 days OR already used) return `{ error: "expired", relogin_path: "/login" }` together with a clear message in `AuthMagicLink.tsx` telling the student to reopen the bot and tap the button again.
- Keep the security model: we never mint a session for an expired token, we only improve the user-facing copy and the redirect.

### 4. Verify

- Hit `/v1/projects/.../config/auth` to confirm the new `inactivity_timeout` and `timebox` are applied.
- Insert a test row into `telegram_magic_links` with `expires_at = now() + interval '7 days'` and confirm `magic-link-redeem` accepts it.
- Tap a freshly-generated bot button → land on `/dashboard` signed in. Wait a day, tap the same button → still signed in. Wait > 7 days → see the new friendly expired screen.

### Files touched

- `supabase/migrations/<new>.sql` — change `telegram_magic_links.expires_at` default to 7 days.
- `supabase/functions/telegram-bot-webhook/index.ts` — extend `createMagicLink` reuse window + explicit 7-day `expires_at`.
- `supabase/functions/magic-link-redeem/index.ts` — friendlier expired/used response.
- `src/pages/AuthMagicLink.tsx` — show "open the bot and tap the button again" copy when the server reports `expired`.
- Supabase Auth config (server-side, no project file): `inactivity_timeout = 604800`, `timebox = 2592000`.

### Out of scope (intentionally)

- Telegram in-app browser storage behavior cannot be controlled from our code; the 7-day magic-link lifetime + 7-day Supabase session is what guarantees the "no re-login for a week" promise even when the in-app browser starts fresh.
- No changes to lesson playback, progress, or RLS — this is auth/session only.
