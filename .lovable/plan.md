## Goal

Add `/start` (and the other commonly-used commands) to the blue **Menu** button next to the Telegram message input, so users can tap "Menu → /start" instead of typing it.

Telegram populates that menu from `setMyCommands`. This is a one-time API call per bot — not something to do on every webhook hit.

## Approach

Run `setMyCommands` once via the Bot API. Commands and short descriptions in 3 locales (uz/ru/en) so the menu localizes for each user.

**Commands to register** (covering both student and teacher/admin daily use, all already implemented in `telegram-bot-webhook/index.ts`):

- `/start` — Boshlash / Начать / Start
- `/davom` — Darsni davom ettirish / Продолжить урок / Continue lesson
- `/vazifalar` — Vazifalar / Задания / Homework
- `/galaba` — Yutuqlarim / Достижения / Achievements
- `/dars` — Bugungi dars / Урок дня / Today's lesson
- `/sertifikat` — Sertifikat / Сертификат / Certificate
- `/til` — Tilni almashtirish / Сменить язык / Language
- `/yordam` — Yordam / Помощь / Help

(Teacher/admin commands like `/baholash`, `/analitika` are kept out of the public menu — they're available via the persistent reply keyboard for those personas.)

## Execution

Run `setMyCommands` three times from the sandbox using curl against `api.telegram.org` with the existing `TELEGRAM_BOT_TOKEN` secret, once per `language_code` (`uz`, `ru`, `en`) plus a default call without language to cover other locales.

```
POST https://api.telegram.org/bot<token>/setMyCommands
{ "commands": [...], "language_code": "uz" }
```

Also call `setChatMenuButton` with `{ "menu_button": { "type": "commands" } }` to ensure the Menu button shows the commands list (this is the default, but explicit guarantees it isn't stuck on a previously-set web_app button).

No code changes to the webhook function are needed — registration is a one-shot bot-config operation.

## Verification

1. After running, in Telegram open a chat with the bot.
2. The blue "Menu" button next to the input should list `/start` first plus the other commands.
3. Switch Telegram interface to Russian — descriptions update accordingly.
4. Tap `/start` from the menu — the existing `/start` handler in the webhook fires and replies with the welcome / main keyboard.
