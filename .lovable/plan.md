# Investigation: "Student progress wiped overnight"

## TL;DR — checked the DB, no progress was wiped

Before changing anything I read the actual production data and every code path that writes to progress tables. **No student progress has been deleted or reset.** The reports are almost certainly a *display / wrong-account* issue, not data loss. I want to confirm with one or two real student accounts before adding fixes.

## What I checked (read-only)

**1. Code paths that write to `lesson_progress`** — only two exist, both safe:

- `LessonPage.tsx` → `supabase.rpc("track_video_progress", …)` and an `upsert` on lesson end / "Mark complete". Both only ever set `completed_at` to a value, never to `NULL`.
- The `track_video_progress` SQL function uses
  `SET completed_at = COALESCE(completed_at, now_ts)` — once a lesson is completed, that timestamp is preserved on every subsequent tick. It is structurally impossible for replaying a lesson to un-complete it.

**2. Code paths that DELETE from progress tables** — none.
`rg "delete|truncate|reset"` across `supabase/functions/**` and `src/**` finds zero deletes against `lesson_progress`, `homework_submissions`, `quiz_attempts`, or `module_celebrations`. The only deletes are: `bot_homework_intents` (transient state), `login_attempts` (rate-limit cache), and merging duplicate auth users in `admin-merge-duplicates`.

**3. Cron jobs** — `streak-rollover`, `cron-engagement`, `leaderboard-recalc`, `weekly-digest`, `detect-and-nudge` all read progress, none write/delete.

**4. Recent migrations (last 7 days)** — none touch `lesson_progress`, `homework_submissions`, or `enrollments` schema. The most recent change was adding `module_celebrations` and dropping the old `certificates` table (unrelated to progress).

**5. Live data check:**

- `lesson_progress`: 3,605 rows, **3,220 with `completed_at` still set**, latest `updated_at` = today 08:42 UTC. Hourly write volume is steady (no mass-update spike).
- Students whose completed lessons belong to a course they are not enrolled in: **0**.
- Users with duplicate `enrollments`: **0**.

So the underlying progress is intact for every student in the database.

## Most likely real cause

Because the data is fine but the *user experience* is "I'm back at module 1", the candidates are:

1. **Logged into a different account.** A student who reaches the platform via a different magic-link / a re-issued invite / a different email lands on a fresh profile that genuinely has zero progress. The merge-duplicates function exists precisely because this happens.
2. **Telegram bot showed a different profile.** If the student's `telegram_user_id` got linked to a second profile (e.g. they tapped a fresh deep-link from another account), `/vazifalar` would render that other profile's empty state.
3. **Dashboard showed a different course.** `Dashboard.tsx` lists per-enrollment progress; if a new course/enrollment was added, the new card legitimately shows 0% and can read as "wiped".

None of these are bugs that touch stored progress, but #1 and #2 are user-visible regressions worth hardening.

## Plan

### Step 1 — Confirm with one real case (no code change yet)
Ask the user (out of band) for **the Telegram username or email of one affected student**. I'll then run a single read-only query (`profiles` + `lesson_progress` + `enrollments` + `telegram_user_id` history) to show exactly what that student's data looks like. This will tell us instantly whether it's a duplicate-account / wrong-profile issue or something else, and will save us from changing code blindly.

### Step 2 — Defensive safeguards (only after Step 1 confirms)

These are cheap and worth adding regardless, because they make any future regression *impossible* and *observable*:

- **DB trigger `lesson_progress_protect_completion`** on `BEFORE UPDATE`: if `OLD.completed_at IS NOT NULL` and `NEW.completed_at IS NULL`, force `NEW.completed_at = OLD.completed_at`. Same idea for `homework_submissions.score`: never let a non-null `score` be replaced by `NULL`. Pure safety net — current code does not try to do this, so the trigger is a no-op in normal flow.
- **Audit table `progress_audit`** (id, user_id, table_name, row_id, op, before, after, changed_at). Triggered on any DELETE or "completed_at cleared" / "score cleared" UPDATE on `lesson_progress` and `homework_submissions`. Lets us prove, with a row-level log, that no destructive write happened.
- **Duplicate-profile guard in the Telegram bot:** when `telegram_user_id` resolution finds **>1** profile, log `bot:profile:duplicate {telegram_id, profile_ids}` and prefer the profile with the most recent `lesson_progress.updated_at` instead of silently using the newest profile row. (Read the chat history once — if duplicates show up here, that's the real fix.)

### Step 3 — Tiny UI clarification on Dashboard
If a student has multiple enrollments, label the 0% card with the course title prominently and add a "Continue your other course" link to the one with progress. This removes the "wait, where did my progress go?" reaction when a new course is added.

## Out of scope

- No changes to grading, the homework matrix view we just built, or the Telegram graded-students button.
- No schema migrations on `lesson_progress`/`homework_submissions` columns themselves — only triggers + an audit table.

## What I need from you

A single Telegram username (or email) of a student who reported this. With that I can either: (a) prove it was a wrong-account/duplicate-profile situation and we go straight to Step 2, or (b) find a real bug if one exists, in which case the plan changes.
