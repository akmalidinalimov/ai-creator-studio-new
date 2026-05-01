## Answer to your question first

**Yes — after the previous fix, the Telegram login flow already does exactly what you described.** No phone-number widget anywhere. Verified by reading the code:

1. User clicks "Telegram orqali kirish" on `/login` or `/signup` → `TelegramDeeplinkButton` opens `t.me/<bot>?start=login_<token>` in a new tab. No `oauth.telegram.org`.
2. Inside the bot, the webhook (`telegram-bot-webhook/index.ts`) looks up the user by **telegram_id OR @username** in the `profiles` table.
3. If found → magic link to `/dashboard`, user is logged in.
4. If NOT found → bot sends the "not registered" message with an inline button linking to the Google Form.

The "not registered" message currently in production (Uzbek):
> "Sizning Telegram hisobingiz hali ro'yxatdan o'tmagan. Ro'yxatdan o'tish uchun quyidagi formani to'ldiring."
> [📝 Formani to'ldirish] → `https://forms.gle/o8Dcx1tA8ZBeGk6t9`

So the **behavior** matches your spec. What's missing is admin control — both the text and the form URL are hardcoded in the edge function. Your new ask is to make them editable from `/admin/settings`.

## What this plan changes

Make the enrollment message + button label + form URL editable from the admin panel for all 3 languages (uz / ru / en), with your preferred Uzbek text as the new default.

### 1. Database — store enrollment settings

Add a new row to the existing `platform_settings` table (key = `telegram_enrollment`) with shape:

```json
{
  "form_url": "https://forms.gle/o8Dcx1tA8ZBeGk6t9",
  "message": {
    "uz": "Sizning ma'lumotingiz platformaga kiritilmagan ko'rinadi. Pastdagi tugmani bosib, ma'lumotingiz qoldiring va sizga 24 soat ichida platformaga dostup beriladi",
    "ru": "Похоже, вашей информации нет на платформе. Нажмите кнопку ниже, оставьте свои данные — доступ будет открыт в течение 24 часов",
    "en": "Your information doesn't appear to be on the platform. Tap the button below, leave your details, and you'll get access within 24 hours"
  },
  "button_label": {
    "uz": "📝 Formani to'ldirish",
    "ru": "📝 Заполнить форму",
    "en": "📝 Fill out the form"
  }
}
```

Seeded via SQL migration so production immediately uses the new Uzbek text you wrote. RLS already covers `platform_settings` (admin-only writes, public read via the existing `get_public_setting` RPC — but since this contains no secrets we'll just allow admins to read+write directly).

### 2. Edge function — read settings instead of hardcoded constants

In `supabase/functions/telegram-bot-webhook/index.ts`:
- Remove the `ENROLL_FORM_URL` constant and the `notRegistered` / `fillForm` strings from the `T` translations.
- At the top of `handleStartLogin` (and the `/start` branch in `handleCommand`), fetch the `telegram_enrollment` row from `platform_settings` once, fall back to the bundled defaults if the row is missing or a locale field is empty.
- Send the message with the inline button using the resolved `form_url` and `button_label[locale]`.

No other behavior changes — `/myid` still works, hybrid id+username matching stays, magic-link login on success stays.

### 3. Admin UI — new editable card on `/admin/settings`

Add a third card under the existing Telegram bot card titled "Enrollment message" containing:
- One **Input** for the Google Form URL (with URL validation on save).
- Three **Textarea** fields, one per locale (Uzbek / Russian / English) for the message body. Tabs or stacked — stacked with locale labels keeps it simple.
- Three **Input** fields for the button label per locale.
- A **Save** button that upserts the row into `platform_settings` (key=`telegram_enrollment`).
- A small preview block showing how it will look in Telegram for the currently-selected locale.

All UI strings localized in `en.json` / `ru.json` / `uz.json`.

### 4. Verification after deploy

- Open `/admin/settings`, edit the Uzbek message, save → confirm row written.
- From an unenrolled Telegram account, hit the deeplink → bot replies with the new admin-edited text and the configured form button.
- From an enrolled account → still logs in as before, no regression.

## Files touched

- `supabase/migrations/<new>.sql` — seed `telegram_enrollment` row.
- `supabase/functions/telegram-bot-webhook/index.ts` — load settings, drop hardcoded URL/strings.
- `src/pages/admin/AdminSettings.tsx` — new "Enrollment message" card with form-URL + per-locale message + button label inputs.
- `src/i18n/locales/{en,ru,uz}.json` — labels for the new admin card.

## Out of scope (not changing)

- Login flow itself (already correct — no phone widget).
- `/myid`, `/galaba`, watch-tracking, AI assistant, magic links, CSV import, video upload limits.
- Database schema beyond the one new row.
