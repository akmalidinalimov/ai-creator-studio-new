# Sales intake → platform auto-import (Google Sheet)

Sales fill one row per new student in a **private** Google Sheet. Every 15 minutes the sheet
auto-imports new rows into the platform (course + tier + group) and writes back a Status. Admins get
an evening Telegram report with the day's import count.

The sheet stays **private** — student data is sent over an authenticated HTTPS call, never published.

## What sales fill (one row per student)

| Column | Required? | Notes |
|---|---|---|
| **First name** | ✅ | |
| Last name | optional | |
| **Telegram username** | ✅ | e.g. `@ali_valiyev` — this is how the bot recognizes the student |
| **Course** | ✅ | dropdown, exact course title (e.g. `AI CREATORS 5.0`) |
| **Tier** | ✅ | dropdown: `Premium`, `VIP`, or `Full` (`Full` = all modules, no limit) |
| **Group** | ✅ | the group name for that course (e.g. `5.0 Group A`); auto-created if new |
| Phone | optional | stored for your records |
| Email | optional | |
| Status / Imported at / Notes | — | filled automatically by the script — don't edit |

A row is imported once it has all the required fields **and** an empty Status. To re-import a row,
clear its **Status** cell.

Re-imports are safe: a student already on the platform shows `✔️ Already on platform`, never a duplicate.

## One-time setup (owner)

1. **Create the sheet.** New Google Sheet → rename the first tab to **`Intake`**. Import
   `intake-template.csv` (File → Import → Upload → *Replace current sheet*) to get the exact header row,
   then delete the 3 example rows.
2. **Add dropdowns** (Data → Data validation):
   - **Course** column → list of your exact course titles (e.g. `AI CREATORS 5.0`).
   - **Tier** column → `Premium`, `VIP`, `Full`.
3. **Add the script.** Extensions → Apps Script → delete the default code → paste all of
   `apps-script.gs` → Save.
4. **Set the secret.** In Apps Script: Project Settings (⚙️) → Script properties → Add property →
   name `SHEET_SYNC_SECRET`, value = the **same secret** set in Supabase (`SHEET_SYNC_SECRET`). The
   secret never goes in a cell or in the code.
5. **Start the automation.** In the Apps Script editor, select the function **`installTrigger`** and
   click ▶ Run once; approve the permission prompt. This creates the every-15-minutes trigger.
6. **Share** the sheet with the sales team (Editor access). They only fill columns A–H.

## How to test
Add a row with your own `@username`, Course `AI CREATORS 5.0`, Tier `Premium`, a Group — leave Status
empty. Within ~15 min (or run `processRows` manually once) the Status becomes `✅ Imported`. Check the
platform: the student exists in 5.0 with a Premium enrollment and that group.

## Statuses you may see
- `✅ Imported` — created on the platform.
- `✔️ Already on platform` — that @username already existed (no duplicate created).
- `⚠️ missing_field` — a required column is blank.
- `⚠️ unknown_course` / `⚠️ unknown_tier` — the Course/Tier value doesn't match the platform (check the dropdown).
- `❌ Error` — see the Notes cell.

## Platform side (already deployed)
- `sheet-sync` edge function receives the rows (secret-gated) and creates each student via the existing
  import engine, then sets the tier (+ optional phone).
- `cron-import-digest` DMs each admin at ~18:00 their local time: "📥 New students imported today: N".
