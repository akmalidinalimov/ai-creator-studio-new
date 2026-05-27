# Student 360 — Admin Per-Student Detail Page

A new admin page that shows everything about one student in one place: profile, lessons watched, homework history, Telegram bot activity, and engagement signals.

## Route & Navigation

- New route: `/admin/users/:id` (component `AdminStudentDetail.tsx`)
- Entry points:
  - `/admin/users` — make each row clickable → opens detail page (keeps existing "Manage" drawer for quick edits)
  - `/admin/groups/:id` — student rows link to the detail page
  - `/admin/homework` — student name in submissions links to detail page

## Page Layout

Header card: avatar, name, email, role badge, group, Telegram link status, join date, last active, quick actions (Open Manage drawer, Send DM via bot, Copy email).

Tabs:

1. **Profile** — name, email, language, group, role, archived status, signup source, magic-link status, password set y/n. Read-only summary (editing stays in the existing Manage drawer).

2. **Lessons** — table of every lesson with: module, lesson title, watch %, watch time, last position, completed_at. Sort by module/position. Top KPIs: total lessons completed, total watch minutes, current streak, last 7d minutes.

3. **Homework** — per-assignment row: module #, task #, status (not submitted / submitted / graded / late / resubmitted), submitted_at, score, attempts count, source (web/telegram), link to submission (opens grader drawer). Show full attempts history (previous_attempts JSON) in an expand row.

4. **Telegram** — link status (telegram_id, username, first/last name), `/myid` history, last bot interaction, list of submissions made via bot, DM delivery log (from `homework_teacher_dm_queue` where student_id = this user, plus any DMs sent to this student from `notifications_log`).

5. **Engagement** — streaks (current + longest), logins (last 30, from `auth_events`), nudges sent (`nudge_log`), badges earned, leaderboard rank, daily watch heatmap (last 90d from `daily_watch_summary`).

## Data Sources (read-only queries)

- `profiles`, `user_roles`, `groups`, `enrollments`
- `lessons`, `modules`, `lesson_progress`, `daily_watch_summary`
- `homework_assignments`, `homework_submissions`
- `bot_homework_intents`, `group_message_events`, `homework_teacher_dm_queue`, `notifications_log`
- `auth_events`, `nudge_log`, `badges` + award table, `leaderboard_cache`

All queries scoped by `user_id = :id`. Access gated by `has_role(auth.uid(), 'admin')` — existing RLS already covers most tables; for the few that are admin-only-read, queries run from the admin session and will pass.

## Files

- `src/pages/admin/AdminStudentDetail.tsx` (new) — main page with tabs
- `src/components/admin/student/ProfileTab.tsx`
- `src/components/admin/student/LessonsTab.tsx`
- `src/components/admin/student/HomeworkTab.tsx`
- `src/components/admin/student/TelegramTab.tsx`
- `src/components/admin/student/EngagementTab.tsx`
- `src/App.tsx` — register `/admin/users/:id` route
- `src/pages/admin/AdminUsers.tsx` — row click → navigate to detail
- `src/pages/admin/GroupDetail.tsx` — link student names to detail
- `src/pages/admin/AdminHomework.tsx` — link student names to detail
- i18n keys in `en.json` / `ru.json` / `uz.json`

## Non-goals

- No new edit flows here (Manage drawer stays the editor)
- No new tables or migrations
- No changes to Telegram bot / submission logic
