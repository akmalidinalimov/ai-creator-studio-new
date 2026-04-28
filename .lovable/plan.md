## Change "Birinchi darsni ochish" → "Darsni Ko'rish"

This text is the post-`/start` welcome keyboard button in the Telegram bot. It's hardcoded in `supabase/functions/telegram-bot-webhook/index.ts` (the `T.uz.btnFirstLesson` constant), not in the admin-editable `notification_templates` table or anywhere in the React app.

### Change

In `supabase/functions/telegram-bot-webhook/index.ts`:

- Line 34 (UZ): `btnFirstLesson: "📚 Birinchi darsni ochish"` → `"📚 Darsni Ko'rish"`

### Other locales — update for parity?

The same button exists in RU and EN with matching meaning:
- Line 83 (RU): `"📚 Открыть первый урок"` → `"📚 Посмотреть урок"`
- Line 132 (EN): `"📚 Open first lesson"` → `"📚 Watch lesson"`

I'll update all three so the button stays consistent across languages. If you only want UZ changed, say so before approving.

### Deploy

After the edit, redeploy the `telegram-bot-webhook` edge function so the new label appears in the next `/start` welcome message. No DB migration needed.