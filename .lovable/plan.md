# v1.9.3 — Rename G'alabam → Statistikam, remove Yordam button

Small polish to the persistent reply keyboard in `supabase/functions/telegram-bot-webhook/index.ts`. Slash commands (`/galaba`, `/yordam`) continue to work; only the visible buttons change.

## Changes

### 1. Rename the "streak" button label (all 3 locales)
In the `T` translations constant:
- `uz.kbStreak`: `"🏆 G'alabam"` → `"📊 Statistikam"`
- `ru.kbStreak`: `"🏆 Мои победы"` → `"📊 Моя статистика"`
- `en.kbStreak`: `"🏆 My streak"` → `"📊 My stats"`

Note: this makes `kbStreak` identical to the existing `kbStreakOld` alias — that's fine, the router in `buttonTextToCommand` will still route it to `/galaba`.

### 2. Remove the Yordam button from the keyboard layout
In `getMainKeyboard()`, change row 3 from:
```ts
[{ text: t.kbLang }, { text: t.kbHelp }],
```
to:
```ts
[{ text: t.kbLang }],
```

The `kbHelp` translation string and the `/yordam` slash command are kept intact (so users typing `/yordam` and the help reply text still work). The `buttonTextToCommand` mapping for `kbHelp` is also left in place so that any stale "❓ Yordam" buttons rendered on a user's old keyboard still route correctly until Telegram refreshes.

### 3. Deploy
Deploy the `telegram-bot-webhook` edge function so the new keyboard ships immediately.

## Out of scope
- No DB changes.
- No frontend changes.
- BotFather command list unchanged.
- All other v1.9.x behavior (login flow, /galaba, /dars magic link, language switch, certificate flow) untouched.
