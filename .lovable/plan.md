## Problem

When an unregistered Telegram user messages the bot, `sendUnregisteredReply` sends a hardcoded message ("Salom! Siz hali AI Creators Academy...") with a link to `@shahlo_alikhanova` and `aicreator.academy`. It ignores the admin-configured "Telegram ro'yxatga olish xabari" stored in `platform_settings.telegram_enrollment` (message + button label + form URL, per locale).

The `/start login_<token>` flow at line 1176 already correctly uses `getEnrollmentSettings()` and shows the configured message with the form button. Only the generic "any other message" path uses the hardcoded text.

## Fix

Update `sendUnregisteredReply` in `supabase/functions/telegram-bot-webhook/index.ts` so it:

1. Accepts the `admin` Supabase client and a `locale` (derived from `from.language_code`).
2. Loads the configured enrollment text via the existing `getEnrollmentSettings(admin, locale)` helper.
3. Sends the configured message with an inline keyboard button `[{ text: buttonLabel, url: formUrl }]` — same pattern as the login-token branch.
4. Falls back to the existing `DEFAULT_ENROLL_*` constants if `platform_settings` row is missing.
5. Keeps the current 60s per-telegram_id throttle and the `remove_keyboard` reply markup is dropped (inline buttons can't be combined with `remove_keyboard`; a prior reply keyboard will simply remain — acceptable, matches login flow).

Update the three call sites to pass `admin` and a locale:
- line ~2202 (private-chat fallback inside an existing handler)
- line ~3382 (private chat, identity gate)
- line ~3440 (callback_query, identity gate) — locale from `cq.from.language_code`

Remove the `UNREGISTERED_TEXT` constant (no longer used).

No DB changes, no UI changes, no other behaviour changes. Only the unregistered-reply text path is affected.

## Files

- `supabase/functions/telegram-bot-webhook/index.ts` — modify `sendUnregisteredReply` + 3 call sites.

## Verification

1. From a Telegram account NOT in the database, send any message (e.g. `hi`) to the bot.
2. Bot should reply with the exact text configured in Admin → Settings → "Telegram ro'yxatga olish xabari" for the appropriate locale, plus the "📝 Formani to'ldirish" button linking to the configured form URL.
3. Edit the message in the admin panel, save, send another message from the unregistered account → updated text appears.
4. Registered users are unaffected.
