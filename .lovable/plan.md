## Root cause

Resubmitted homework is invisible to the teacher because a database trigger silently keeps the previous grade on the row, so it never shows up as "ungraded".

### What I found in the data

Looking at @guli_aistudio's group, three recent resubmissions are stuck in a broken state — score still set, `scored_at` is NULL, `score_is_stale = false`:

| submission | student | score | scored_at | resubmits |
|---|---|---|---|---|
| `c04e619a` | NargizaAI | 8 | NULL | 1 |
| `8d3b60ee` | Oyro'zigul | 9 | NULL | 5 |
| `054ac117` | Элшод | 0 | NULL | 5 |

The audit trail (`progress_audit`) shows each resubmission cycle ends with a **`BLOCKED_CLEAR_SCORE`** entry — the database trigger reverted the upsert's attempt to clear the score.

### Why

Two pieces of code disagree about how to mark a resubmission:

1. `start_homework_resubmission` RPC (fires when student taps 🔁): bumps `attempt_number`, sets `score_is_stale = true`, **keeps** the old score.
2. `handleGroupTopicMessage` (fires when student actually posts the new file in the topic): upserts with `score: null, scored_at: null, score_is_stale: false`, but does **not** touch `attempt_number`.
3. `homework_submissions_guard` trigger: only allows clearing `score` when `NEW.attempt_number > OLD.attempt_number`. The upsert in step 2 doesn't bump it (RPC already did at step 1), so trigger reverts `NEW.score := OLD.score`.

Net effect on the new resubmission row:
- `score` stays at the previous grade
- `scored_at` becomes NULL (allowed through)
- `score_is_stale` becomes `false`
- `telegram_message_url` updates to the new post

Both the bot pending list (`/galaba`) and the web teacher dashboard (`TeacherHomework.tsx`) filter by `score IS NULL` / `r.score == null`, so the resubmission is invisible. Some resubmissions also miss the teacher DM queue insert because the upsert path silently rolls back fields it expected to change.

## Fix (single edit)

Make `handleGroupTopicMessage` bump `attempt_number` on the upsert so the guard trigger lets the score clear:

```ts
// supabase/functions/telegram-bot-webhook/index.ts, ~line 3217 (before the upsert)
const { data: existingSub } = await admin
  .from("homework_submissions")
  .select("attempt_number")
  .eq("user_id", profile.id)
  .eq("assignment_id", intent.assignment_id)
  .maybeSingle();
const nextAttempt = (existingSub?.attempt_number ?? 0) + 1;
```

Then add `attempt_number: nextAttempt` to the upsert payload at line ~3245. After this, on every student post that consumes an intent:
- New rows: `attempt_number = 1`, score is NULL → guard not triggered.
- Resubmissions: `attempt_number` increments past the previous value → guard allows score clear → row becomes truly ungraded → both `/galaba` and the web dashboard show it → `notifyTeachersOfSubmission` queues the fresh DM with the new message URL.

## Backfill

To rescue the 3 already-broken rows so the teacher sees them now:

```sql
UPDATE public.homework_submissions
SET score = NULL, score_feedback = NULL, scored_by = NULL,
    scored_at = NULL, score_is_stale = false,
    attempt_number = COALESCE(attempt_number, 1) + 1
WHERE id IN (
  'c04e619a-0af8-4b0f-9190-5f031a216276',
  '8d3b60ee-9dff-4c0f-8a78-1b65239bdd59',
  '054ac117-37b8-4cd4-8e60-0e6deb9a1cb4'
);
```

The previous grades are preserved in `previous_attempts` already, so nothing is lost.

I won't run a broader sweep — only these 3 are confirmed broken from the data I inspected. If you want me to widen the backfill to all teachers (any row where `score IS NOT NULL AND scored_at IS NULL AND jsonb_array_length(previous_attempts) > 0`), say the word and I'll include it in the migration.

## Out of scope

- No change to `start_homework_resubmission` RPC.
- No change to the `homework_submissions_guard` trigger.
- No change to the pending-list queries — once the upsert clears the score correctly, existing filters work.
- No change to grading flows, DM templates, web UI, or notification cron.

## Verification

1. Apply the code edit + backfill migration; deploy `telegram-bot-webhook`.
2. Confirm the 3 backfilled rows appear in @guli_aistudio's `/galaba` list and on TeacherHomework.
3. Pick a fresh test resubmission: student taps 🔁 → posts new file → teacher gets a new DM with the new `t.me/...` link, the row appears in `/galaba`, and grading replaces the previous grade (which lives in `previous_attempts`).
4. Audit row confirms no new `BLOCKED_CLEAR_SCORE` entries after the fix.