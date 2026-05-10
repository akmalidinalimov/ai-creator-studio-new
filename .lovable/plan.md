## Goal

Surface every piece of historical data we already have. Today the tables hold all the raw events (3,920 lesson_progress rows, 1,108 daily_watch_summary rows, 261 homework submissions, 15,602 auth events, all going back to 2026‑04‑28), but a few derived/cache tables are stale and there is no place for a student to see their own historical activity. Fix the stale caches once, give students a real "My activity" page, and confirm teacher stats render the same data without a "today only" feel.

## What's actually missing

After auditing the DB:

- **`leaderboard_cache`** is **5 days stale** (last `computed_at` = 2026‑05‑05). The `recalc_leaderboard` job hasn't run lately, so the Leaderboard page shows old ranks/scores. → needs one recalc + scheduled refresh.
- **`streaks`**: every active user already has a row (0 missing). No backfill needed; just verify the cron still ticks.
- **`daily_watch_summary`** date range matches `lesson_progress` (both start 2026‑04‑28). Nothing to backfill, but the per‑user totals are higher than `lesson_progress.watch_seconds_total` due to the join in `cron-engagement` — this is existing behaviour, not a bug we need to "fix" now.
- **Student "My activity" view does not exist.** Today the student dashboard shows weekly bars + module progress + engagement tiles, but there is no historical timeline of "videos I watched, homework I submitted, badges I earned, lessons I completed". This is what the user is asking for.
- **Teacher dashboard** already loads from live RPCs (we verified last loop). The new `InactiveStudentsList` is in place. We just need to confirm nothing is hard‑capping to "today" and add a small "lifetime totals" strip so teachers can see we are not starting fresh.

## Changes

### 1. One‑time backfill / recompute (no schema changes)

Run via existing functions, no new tables:

- `select recalc_leaderboard();` — refreshes ranks, `lessons_30d`, `minutes_30d` from current `lesson_progress` + `streaks`.
- `select update_streak_for_user();` sweep for any user whose `last_active_date` < today but who has a `lesson_progress.updated_at` today (catches anyone the trigger missed).
- Spot‑check `daily_watch_summary` for users who have `lesson_progress.watch_seconds_total > 0` but no row — backfill from `lesson_progress` grouped by `DATE(updated_at)` if any are found.

These are insert/update operations, executed via the insert tool. No migration.

### 2. New student page: **My Activity** (`/activity`)

A single scrollable page that pulls everything we already have for the signed‑in user and renders it as a unified timeline + summary.

Top "Lifetime totals" strip (4 tiles):
- Total watch time (sum of `lesson_progress.watch_seconds_total`)
- Lessons completed (count `completed_at not null`)
- Homework submitted / scored / avg score (`homework_submissions`)
- Current streak / longest streak (`streaks`)

Sections below:
- **Videos watched** — table grouped by course → module → lesson, columns: lesson title, last watched (`updated_at`), watch time, completed ✓. Sorted newest first. Reuses `lesson_progress` joined to `lessons/modules/courses`.
- **Homework history** — list of submissions, columns: module, task #, submitted at, score, late?, link to the Telegram message if present. From `homework_submissions`.
- **Badges earned** — chips from `user_badges` if present, else hide.
- **Daily activity (last 90 days)** — heatmap‑style strip from `daily_watch_summary`.
- **Login history (last 30 days)** — small list from `auth_events` where `event = 'login'`.

Add a "Statistics" / "My activity" link in `StudentBottomNav` and a button on the dashboard ("View full history →").

### 3. Teacher dashboard: confirm + small "lifetime" strip

On `AdminDashboard.tsx`, above the existing 30‑day tiles, add a 4‑tile **Lifetime** row scoped to the teacher's group(s):
- Total students, total lessons completed (all‑time), total watch hours (all‑time), total homework submitted.

Sourced by extending `staff_recent_lesson_progress` callsites to also fetch lifetime aggregates (or one new RPC `staff_lifetime_totals(_group_id)` — single SELECT, no new tables). Pick the RPC route to keep RLS clean.

Confirm (no behaviour change unless broken):
- Existing tiles are not silently filtering to "today" — they already use `>= now() - interval '30 days'`, fine.
- `inactive3List`, `TeacherLoginAnalytics`, `InactiveStudentsList` reload on group change.

### 4. Keep the caches fresh

- Verify `cron-engagement` (writes `daily_watch_summary` + bumps streaks) and `leaderboard-recalc` are scheduled. If `pg_cron` schedules are missing, add them in a migration:
  - `cron-engagement` every 15 min
  - `leaderboard-recalc` every hour
- This is the only migration in scope, and only if the schedules are actually missing.

## Out of scope

- No changes to `lesson_progress`, `homework_submissions`, `auth_events` schemas.
- No new badge logic.
- No teacher‑side per‑student deep dive page (existing group pages cover this).

## Files

- New: `src/pages/MyActivity.tsx`, `src/components/activity/*` (lifetime tiles, video table, homework list, heatmap, login list).
- Edited: `src/App.tsx` (route), `src/components/StudentBottomNav.tsx` (link), `src/pages/Dashboard.tsx` (link), `src/pages/admin/AdminDashboard.tsx` (lifetime strip), `src/i18n/locales/{uz,ru,en}.json`.
- Possibly new: one RPC `staff_lifetime_totals` + one migration scheduling the two crons (only if not already scheduled).

## Open questions

1. Should "My Activity" be reachable from the bottom nav (replacing/adding to current items), or only from a dashboard button?
2. Lifetime totals on the teacher dashboard — do you want them per‑group (filtered by the current group dropdown) or always across all the teacher's groups?
