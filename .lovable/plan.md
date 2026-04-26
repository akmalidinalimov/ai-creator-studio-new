## Root cause

Telegram's OAuth popup at `https://oauth.telegram.org/auth` requires a **numeric `bot_id`** parameter (the digits before the `:` in the bot token — for your bot, `8243263934`). The current `TelegramLoginButton.tsx` only passes `bot=<username>`, which is why the page shows **"Bot id required"**.

The bot token is already saved correctly in `platform_settings` and the HMAC verification in the `telegram-auth` edge function works fine. The issue is purely on the client-side popup URL.

## What I'll change

### 1. `get_public_setting` RPC (migration)
Update the `telegram` branch to also return the numeric `bot_id` (parsed from the stored `bot_token`), without ever exposing the token itself:

```sql
-- inside get_public_setting, telegram branch:
result := jsonb_build_object(
  'bot_username', COALESCE(v->>'bot_username', ''),
  'bot_id', COALESCE(split_part(v->>'bot_token', ':', 1), '')
);
```

This keeps the token server-only (still readable only by admins via direct table access) while letting the public login button receive the harmless numeric ID.

### 2. `src/components/TelegramLoginButton.tsx`
- Read both `bot_username` and `bot_id` from the RPC.
- Build the OAuth popup URL as:
  `https://oauth.telegram.org/auth?bot_id=<bot_id>&origin=<origin>&request_access=write&return_to=<origin>`
- Keep the existing `postMessage` listener and the styled "Telegram Bilan Kirish" button unchanged.
- Show the disabled-with-tooltip fallback only when `bot_id` is missing (not just username).

### 3. No other files need to change
- `telegram-auth` edge function already verifies the HMAC using the server-side token — works as-is.
- `Login.tsx` / `Signup.tsx` continue calling `onTelegram` exactly as today.
- `AdminSettings.tsx` continues to save the full token; nothing to update there.

## What you don't need to do

You **don't** need to add `TELEGRAM_BOT_TOKEN` as a secret — the token is read from `platform_settings` by the edge function, and that's already populated.

The only Telegram-side requirement is that the bot's login domain (set via `/setdomain` in BotFather) matches your site's domain. Once this fix is in, if Telegram still rejects the popup, I'll point you to the BotFather domain step.

## Files touched
- New migration: update `public.get_public_setting` to also return `bot_id` for the `telegram` key.
- Edit: `src/components/TelegramLoginButton.tsx`.