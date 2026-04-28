## Root cause

Anonymous (logged-out) users on the **Signup** page see the toast/tooltip "Вход через Telegram ещё не настроен — администратор может включить его в Настройки → Telegram Login", even though Telegram is fully configured in the database.

`TelegramLoginButton.tsx` calls `supabase.rpc("get_public_setting", { _key: "telegram" })` to fetch the bot's public ID. The April 28 security-hardening migration (`20260428162429_…sql`) revoked `EXECUTE` on `public.get_public_setting(text)` from `PUBLIC` and `anon`, leaving only `authenticated` with access.

Result for anon visitors:
- RPC silently fails with "permission denied for function get_public_setting".
- `data` is `null`, so `bot_id` stays `null`.
- The component renders the disabled fallback with the "not configured" message.

The RPC is designed to be safe for anon — it only returns the non-secret `bot_username`, the public numeric `bot_id` (digits before `:` of the bot token, which Telegram's OAuth widget needs publicly anyway), and the `content_protection` booleans. The hardening was overly broad.

## Fix

Create a migration that re-grants `EXECUTE` on `public.get_public_setting(text)` to `anon`:

```sql
GRANT EXECUTE ON FUNCTION public.get_public_setting(text) TO anon;
```

That's the only change needed. After it runs, the Signup page's Telegram button will resolve `bot_id` for unauthenticated visitors and open the real Telegram OAuth popup instead of the disabled tooltip.

## Verification after deploy

1. Open Signup in an incognito window — the Telegram button should be active (solid blue, clickable) instead of greyed out.
2. Clicking it should open `oauth.telegram.org/auth?bot_id=8243263934&…` rather than showing the toast.
3. Admin/authenticated flows are unchanged (they already had access).
