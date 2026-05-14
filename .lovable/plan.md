# End-to-end test plan: homework submission & resubmission

I'm in plan mode, so I can't execute writes. Here's the test flow I'll run once you approve.

## What I already verified (read-only)

Latest 15 rows in `homework_submissions` show the backfill landed:
- `054ac117`, `8d3b60ee` → `attempt_number=7`, `score=NULL`, `score_is_stale=false` ✅
- `c04e619a` → `attempt_number=3`, `score=NULL`, `score_is_stale=false` ✅

These three resubmissions are now visible to the teacher again.

One row I want to double-check: `83156b3e` (student `56243651…`, assignment `bf5af6a8…`) still has `score=0` with `score_is_stale=true`. Need to confirm `/galaba` and `TeacherHomework` treat `score_is_stale=true` as "needs grading". If they only filter `score IS NULL`, this row stays hidden.

## Test steps (after approval)

1. **Pending-list query check** — Run the same SQL the bot's `/galaba` command and `TeacherHomework.tsx` use, for @guli_aistudio's group, and confirm the three backfilled rows + `83156b3e` (if stale-aware) appear.
2. **Fresh submission (first attempt)** — Pick a test student/assignment with no prior submission. Simulate the topic-message webhook via `curl_edge_functions` against `telegram-bot-webhook`. Verify:
   - Row inserted with `attempt_number=1`, `score=NULL`, correct `telegram_message_url`.
   - `homework_teacher_dm_queue` row created and `sent_at` set.
   - Teacher pending-list query returns it.
3. **Resubmission flow** — For a student with an already-graded submission:
   - Call `start_homework_resubmission` RPC → confirm `score_is_stale=true`, `attempt_number` bumped.
   - Simulate the new file post via webhook → confirm the new fix increments `attempt_number` again, `score` cleared to NULL, old attempt pushed into `previous_attempts`.
   - Confirm trigger doesn't roll the score back.
   - Confirm DM queue + teacher pending list pick it up.
4. **Grading + long comment** — Simulate teacher grading with a >500-char feedback comment. Verify:
   - Full text persisted in `score_feedback` (not truncated).
   - DM to student carries the full comment (no Telegram 4096 truncation; chunked if needed).
5. **Edge function logs** — Tail `telegram-bot-webhook` logs during the run and check for `hw:group:no-matching-intent` or guard-trigger errors.

## Decisions needed

- **Stale-but-nonzero rows** (like `83156b3e`): should "needs grading" include `score_is_stale=true`? If yes, it's a one-line fix to the pending-list filter. If no, I'll leave it.
- **Test fixture**: OK to simulate via `curl_edge_functions` with a synthetic Telegram update payload (no real Telegram traffic), or do you want me to wait for a real student to submit?

Reply with answers and I'll run the suite.
