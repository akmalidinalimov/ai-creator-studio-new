## Goal
Allow students (and teachers acting on their behalf) to resubmit a homework that has already been graded. Single source of truth per (student, assignment): one row, latest grade wins, history preserved. All downstream views (matrix, leaderboard, profile, bot stats) use the latest grade automatically because they already key off `homework_submissions.score`.

## 1. Database

Migration on `homework_submissions`:
- Add `attempt_number int NOT NULL DEFAULT 1`
- Add `previous_attempts jsonb NOT NULL DEFAULT '[]'::jsonb` — array of `{score, score_feedback, scored_by, scored_at, submitted_at, telegram_message_url, attempt_number}`
- Helper `public.start_homework_resubmission(p_submission_id uuid)` (SECURITY DEFINER, validates `auth.uid() = user_id` OR `has_role(auth.uid(),'teacher'/'admin')`):
  1. push current attempt snapshot into `previous_attempts`
  2. increment `attempt_number`
  3. clear `score`, `score_feedback`, `scored_by`, `scored_at`, `is_late`
  4. update `submitted_at = now()`
  5. insert `progress_audit` row `op = 'RESUBMIT'`

Adjust `homework_submissions_guard` trigger: allow `OLD.score IS NOT NULL → NEW.score IS NULL` **only when** `NEW.attempt_number > OLD.attempt_number` (signals a real resubmission). All other clear attempts still log + reinstate as today.

RLS update on `homework_submissions`:
- Keep existing owner update (score IS NULL).
- The resubmission flow goes through `start_homework_resubmission` RPC (security definer), so RLS doesn't need to be widened for normal users.

No changes to `score` column type, leaderboard cache, `vw_module_homework_score`, or matrix queries — they all already read the live `score`.

## 2. Telegram bot (`supabase/functions/telegram-bot-webhook/index.ts`)

### `hw:mod:{moduleId}` handler (around line 3466)
Today it filters out graded leaves. Change to render **all** leaves with state-aware labels:
- Ungraded, no submission → `📤 Vazifa N — title`  → `hw:start:{id}` (today's flow)
- Ungraded, submitted → `⏳ Vazifa N — kutilmoqda`  → `hw:start:{id}` (today's flow)
- Graded → `🔁 Vazifa N — N/M ball — qayta topshirish` → `hw:resub_ask:{id}`

Remove the "all graded" early return so the module button always opens.

### New callback `hw:resub_ask:{assignmentId}`
- Look up the existing submission for this user+assignment.
- Send: `« Sizning oldingi natijangiz: {score}/{max}{feedback}\n\nQayta topshirmoqchimisiz? »`
- Inline keyboard: `[ ✅ Ha, qayta topshiraman → hw:resub_yes:{id} ]  [ ❌ Yo'q → hw:resub_no:{id} ]`
- Localize for uz/ru/en (3 new strings in `T`).

### New callback `hw:resub_no`
- Acknowledge and close: "OK, oldingi natija saqlanadi."

### New callback `hw:resub_yes:{assignmentId}`
- Call `start_homework_resubmission(submission_id)` via service role.
- Then run the existing `startHomeworkIntent(...)` so the student is sent to the topic with the standard "send the file in this topic" instructions and 10-minute intent window.
- From this point on: the existing `handleGroupTopicMessage` upsert path runs unchanged. Because the row was just cleared, the upsert update is a normal score-null→score-null write (trigger no-ops).

### Submission confirmation + teacher notify
No change needed — same `t.hwReceived(...)` DM to student, same `notifyTeachersOfSubmission(...)` queue. Teacher gets a fresh DM identifying it as attempt #N (we'll suffix `(qayta topshirish #${attempt_number})` in `homework_teacher_dm_queue.assignment_title` so the existing notify-homework-submission function shows it without further code changes).

### `/vazifalar` overview (`buildHomeworkMessage`, line ~1186)
Today shows the module button only when `ungraded.length > 0`. Change to always show the button when `groupId && topic`, with a label that flips to `📝 N-MODUL VAZIFASI · qayta topshirish mumkin` if all leaves are graded. This satisfies "module-homework button must remain visible".

### Module average / `/galaba` / leaderboard
These read `score` directly — no code change needed; they recompute on next access. We keep `cacheInvalidateUser(profile.id)` in the resubmit path.

## 3. Web app

### Student — `src/components/lesson/HomeworkSection.tsx`
Inside `renderLeaf`, when `s?.score != null`, in addition to showing the score, render a small `Resubmit` button:
- Calls `supabase.rpc('start_homework_resubmission', { p_submission_id: s.id })`.
- On success: refresh local state, show toast "Vazifa qayta topshirishga tayyor — Telegram topikka yangi javobni jo'nating" and a deep link button to the existing `topicUrl`.

### Teacher — `src/pages/TeacherHomework.tsx` cell drawer
For each graded submission row in the side sheet, add a "Request resubmission" action:
- Calls the same RPC (teachers/admins are authorized inside the function).
- Refreshes the matrix; the cell flips back to ⏳ pending.
- Optionally DMs the student via existing notify path (out of scope for v1; the student will see it in `/vazifalar`).

## 4. Out of scope (explicit)
- No change to grading UI flow, scoring math, Telegram-topic auto-detect, or any other notification template.
- No schema change to leaderboard, module_celebrations, or vw_module_homework_score.
- No backfill — existing rows get `attempt_number = 1`, `previous_attempts = []`.

## Files touched
- `supabase/migrations/<new>.sql` — columns, trigger update, RPC
- `supabase/functions/telegram-bot-webhook/index.ts` — module-button rendering, 3 new callbacks, 3 new locale strings, attempt-tagged title for queue
- `src/components/lesson/HomeworkSection.tsx` — Resubmit button
- `src/pages/TeacherHomework.tsx` — Request-resubmission action in cell drawer
