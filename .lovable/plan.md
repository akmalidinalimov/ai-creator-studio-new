## Problems

1. **Resubmission blocked on already-graded work** — student taps "🔁 qayta topshirish", but the flow sometimes refuses with a "cancel first" message instead of opening the upload prompt. Most likely cause: a stale `bot_homework_intents` row from a previous module (or a previous resub attempt) is still active, and either (a) the RPC `start_homework_resubmission` did not clear `score` (it only flips `score_is_stale = true`), or (b) the upsert of the new intent runs but the bot still routes uploads to the earlier intent because the picker is fragile.

2. **Module mismatch** — student picks Module 2 → submits a Module 2 task → teacher/student notification says Module 3. The DM upload picks "most recent non-expired intent" globally for the student. If an earlier Module 3 intent exists with a newer `created_at` (e.g. because the upsert reused that row and refreshed timestamps), the upload is attached to the wrong assignment.

3. **Logging gaps** — there is no consistent audit trail of who did what (student tap, intent created, upload accepted/rejected, copyMessage result, submission upsert, teacher DM, grading, score change). Hard to diagnose issues after the fact.

4. **Statistics / leaderboard dependencies** — must be invalidated/refreshed on every successful submit, resubmit, and grade event so "My homework", group stats, and leaderboard reflect reality immediately.

## Fixes

### 1. Make module routing strict (no cross-module leakage)

In `supabase/functions/telegram-bot-webhook/index.ts`:

- `startHomeworkIntent` (around line 3080):
  - Before upserting the new intent, **delete every other active intent for this student** (`delete from bot_homework_intents where user_id = profile.id and assignment_id <> assignmentId`). That guarantees the next DM upload can only attach to the assignment the student just tapped.
  - Log `hw:intent:create` with `{profile_id, assignment_id, module_id, module_position, mn, tn, group_id, topic_chat_id, topic_thread_id, expires_at}`.

- `handlePrivateHomeworkUpload` (around line 3372):
  - Continue to pick the latest non-expired intent, but also assert there is exactly one. If more than one exists, log `hw:dm:multi-intent` with all of them and pick the newest by `created_at`.
  - Resolve `mn` (module number) by reading `homework_assignments.module_id → modules.position + 1` from `intent.assignment_id`, not from any cached value, and log `hw:dm:resolved` with `{intent_id, assignment_id, module_id, module_position, mn, tn}`. Reuse that exact `moduleId/mn/tn` for: caption header, student confirmation, teacher DM body, `homework_teacher_dm_queue` row, and `copyMessage` topic resolution.
  - Re-resolve the topic via `resolveModuleTopicUrl(group_id, moduleId)` at upload time instead of trusting the cached `telegram_chat_id/thread_id` on the intent. This protects against the wrong topic being used if the admin edited topic mappings between tap and upload.

### 2. Make resubmission always work

- `hw:resub_yes` handler (around line 3841): before calling `start_homework_resubmission`, also delete competing intents for this user (same cleanup as above), then call the RPC, then call `startHomeworkIntent`. So a stale intent never blocks the new resubmission.

- `startHomeworkIntent` "already graded" guard (line 3099): widen the bypass — allow start when `existing.score_is_stale` OR when the most recent `previous_attempts` entry has a score (meaning the row was already rolled into resubmission mode). Today the check is correct for the RPC path but is fragile if anything else clears `score_is_stale` prematurely.

- Update `start_homework_resubmission` RPC (new migration) so it is idempotent: calling it repeatedly on a row that is already `score_is_stale = true` does nothing destructive (does not double-bump `attempt_number`, does not re-archive). This prevents weird states when the student taps Yes twice.

- Add a small "you have a different submission in progress" message only when the conflict is genuinely ambiguous (different assignment, < 10 min old). Otherwise auto-resolve by replacing it.

### 3. Add structured per-action logging

Introduce a tiny helper `logEvent(actor_profile_id, action, details)` that inserts into `admin_actions` (already exists) for durable audit, and also `console.log` for the function logs. Call it at:

- Student: `/vazifalar` open, module pick, task pick (intent created), resubmission Yes/No, upload accepted/rejected, confirmation sent.
- Teacher: pending list open, "🎯 Baholash" tap, grade submitted, comment submitted, broadcast sent.
- System: `copyMessage` success/fail, teacher DM queued/sent/failed, score saved, `previous_attempts` archived.

Each log line includes `profile_id`, `assignment_id`, `module_id`, `module_number`, `submission_id`, and a stable `action` slug so it is easy to grep in Edge Function logs and in the `admin_actions` table.

### 4. Refresh stats/leaderboard on every event

- After every successful submission, resubmission, and grade write:
  - `cacheInvalidateUser(student_id)` (already exists) — keep it.
  - Bump a lightweight `stats_dirty_at` column on `profiles` (new migration) so dashboards / leaderboard recompute jobs know to recalc.
  - Trigger `leaderboard-recalc` only when a grade is written (not on every submit) to avoid churn.

- Sanity-check that `effectiveLeafGrades` (`homework-stats.ts`) treats a `score_is_stale = true` row the same as "submitted, waiting for grade" so pending resubmissions don't drop a student's average until the new grade lands.

### 5. End-to-end validation

After implementing, validate:

1. Module 2 → Vazifa 2 submit: intent created with module_id = module 2; upload caption, student DM, teacher DM, and `homework_teacher_dm_queue.module_number` all say Module 2.
2. Student opens Module 3 → opens Module 2 → uploads: routed to Module 2 (older intent purged).
3. Student resubmits an already-graded Module 2 task: confirmation prompt → Yes → upload prompt opens (no "cancel first") → upload succeeds → previous grade preserved in `previous_attempts`, current `score = null`, `score_is_stale = true`, teacher gets "Qayta topshirish" DM, student gets resubmission confirmation.
4. Teacher grades the resubmission: `score_is_stale` flips to false, leaderboard recalculated, student's "Mening vazifalarim" reflects the new grade.
5. Direct group-topic upload: still ignored, no submission row, no notifications.
6. `admin_actions` contains the full per-event trail; Edge Function logs show matching structured lines.

## Technical notes

- Files: `supabase/functions/telegram-bot-webhook/index.ts` (most of the change), new SQL migration for the idempotent `start_homework_resubmission` and the `profiles.stats_dirty_at` column.
- No DB schema changes to `homework_submissions` or `bot_homework_intents` other than the `profiles.stats_dirty_at` add.
- Translations: add a small "submission switched to Module X" notice in `uz/ru/en` if we need to inform the student that an older intent was cleared.
- No changes to the web UI (`HomeworkSection.tsx`, `TeacherHomework.tsx`, `homeworkStats.ts`) other than mirroring the `score_is_stale` handling if it is not already aligned.
