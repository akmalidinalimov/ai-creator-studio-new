## Goal
The Telegram login button already renders below the "Continue with Google" button on `/login` and `/signup`. You want its label changed to **"Telegram Bilan Kirish"** (Uzbek).

## Changes

### 1. `src/components/TelegramLoginButton.tsx`
- Change the default `fallbackLabel` prop from `"Continue with Telegram"` to `"Telegram Bilan Kirish"` so the styled fallback button (shown when the bot isn't configured) uses the new label.
- Note: When the Telegram bot **is** configured, the official Telegram widget script renders its own button with fixed text (`"Log in with Telegram"`) — that label is controlled by Telegram and cannot be customized. To get the Uzbek label in *all* states, replace the official widget with our own custom-styled button that triggers Telegram's OAuth popup (`https://oauth.telegram.org/auth`) directly. I'll do this so the label is consistent everywhere.

### 2. `src/pages/Login.tsx` & `src/pages/Signup.tsx`
- No structural changes — button position (below Google) is already correct. The new label flows through automatically.

### 3. `src/pages/admin/AdminSettings.tsx`
- Pass an explicit English `fallbackLabel="Continue with Telegram"` for the admin verification button so the admin UI stays in English while the student-facing auth pages show Uzbek.

## Result
- `/login` and `/signup` show a "Telegram Bilan Kirish" button below "Continue with Google" — visible whether or not the bot is configured.
- Admin settings keeps English copy for the verification widget.
