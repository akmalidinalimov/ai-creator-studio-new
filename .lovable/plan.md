## Goal

On the teacher dashboard, add a clear **Inactive Students (3+ days)** list and confirm every stat a teacher sees is computed from live data each load.

## What teachers see today

Teachers land on `/admin/dashboard` (`src/pages/admin/AdminDashboard.tsx`). They already get scoped tiles for "Inactive 3d" and "Inactive 7d" (counts only), each opens a dialog with a flat table. There is **no inline list** of who is inactive, no day-by-day grouping, and no "∞" marker for very stale students. Teachers also see `TeacherLoginAnalytics` (logins per group) and group cards on `AdminGroups` / `GroupDetail`.

The data behind those tiles comes from RPCs scoped to the teacher's groups: `staff_list_students`, `staff_recent_auth_events`, `staff_recent_lesson_progress`. Last activity = max(`auth_events.created_at`, `lesson_progress.updated_at`) over the last 30 days. With the recent video-progress fix, `lesson_progress.updated_at` now ticks every time a student watches in the bot, so this signal is live.

## Changes

### 1. New "Inactive Students" panel on the teacher dashboard

Add a card directly under the Inactivity tiles (visible to teachers and admins, scoped to the teacher's groups via the existing isTeacher path):

- Title: **Faol bo'lmagan o'quvchilar (3+ kun)** / "Inactive students (3+ days)".
- Buckets in this order: **3 days, 4 days, 5 days, 6 days, 7 days, >7 days (∞)**.
- Students inactive 0–2 days are excluded.
- Each row shows: full name, `@telegram_username` (or `—`), and the inactivity in parentheses, e.g. `Aziza Karimova @aziza (4 kun)` and `Bekzod Tursun @bek (∞)`.
- Each bucket is collapsible; bucket header shows the count. Empty buckets render as "0".
- Sorted within a bucket by most-stale first.
- "Never logged in" stays in its own existing tile (not mixed into this list).
- Reuse the already-built `inactive3List` data: derive `daysSince` per student, then group `3 | 4 | 5 | 6 | 7 | >7`. No new query needed.

### 2. Verify teacher stats are live

Quick audit pass — no behaviour change unless something is stale:

- Confirm the dashboard re-fetches on each mount and on group filter change (it does, via the effect on `courseId`/`groupParam`).
- Confirm `staff_recent_lesson_progress` returns rows scoped to the teacher's groups and is not cached.
- Confirm `lesson_progress.updated_at` is bumped from both web (`BunnyVideoPlayer` heartbeat) and bot (`telegram-bot-webhook` watch handler) — this was the fix from the earlier session, spot-check it still runs.
- Add a small "Yangilangan: HH:MM" timestamp + Refresh button on the dashboard header so teachers can see the data is fresh and force a reload.

### 3. i18n keys

Add to `uz.json` / `ru.json` / `en.json`:

- `admin.dashboard.inactiveList.title`
- `admin.dashboard.inactiveList.bucket` (e.g. `"{{n}} kun"`, `"4 days"`)
- `admin.dashboard.inactiveList.bucketOver7` (`"7+ kun ∞"`)
- `admin.dashboard.inactiveList.empty`
- `admin.dashboard.lastUpdated` + `admin.dashboard.refresh`

## Out of scope

- No DB schema or RPC changes — current RPCs already expose what we need.
- No changes to admin-only views; admins inherit the same panel.
- Existing 3d/7d tiles + dialogs stay as-is.

## Technical notes

- File touched: `src/pages/admin/AdminDashboard.tsx` (add `<InactiveStudentsList rows={inactive3List} />` block + small refresh control), new component `src/components/admin/InactiveStudentsList.tsx`, plus three locale files.
- Bucketing: `const bucket = days > 7 ? '∞' : String(days);` then `groupBy`.
- ∞ rendered as `∞` literal (no icon dependency).
