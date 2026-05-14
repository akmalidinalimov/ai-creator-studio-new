## Bug

When a student taps **🔁 qayta topshirish** in the bot and confirms **Yes**, the bot:

1. Calls `start_homework_resubmission` RPC — which now (correctly) **preserves** the prior `score` / `score_feedback` and just sets `score_is_stale = true`.
2. Then calls `startHomeworkIntent(...)` to open a fresh intent and point the student to the topic.
3. `startHomeworkIntent` checks `homework_submissions.score IS NOT NULL` and bails out with **"Bu vazifa allaqachon baholangan ✅"**.

So the resubmission RPC fires, but the user gets the "already graded" message instead of the topic link. Tapping Yes again repeats the same outcome (RPC is idempotent on the now-stale row).

## Fix (telegram-bot-webhook/index.ts only)

### 1. `startHomeworkIntent` — treat stale grades as resubmittable

In the existing-submission check (around line 2985), select `score_is_stale` and skip the "already graded" block when `score_is_stale === true`. A stale score means the student already pressed "qayta topshirish" — they should be allowed to open a fresh intent.

```ts
const { data: existing } = await admin
  .from("homework_submissions")
  .select("id, score, score_is_stale")
  .eq("user_id", profile.id).eq("assignment_id", assignmentId)
  .maybeSingle();
if (existing && existing.score != null && !existing.score_is_stale) {
  await sendMessage(chatId, t.hwIntentAlreadyScored);
  return;
}
```

### 2. Group-topic upsert — clear the stale flag on the new post

In `handleGroupTopicMessage` (around line 3260), when a new submission post lands and we reset `score`, `score_feedback`, `scored_by`, `scored_at` to null, also set `score_is_stale: false`. Without this, a row briefly looks "stale with no score" between submit and grade.

Add to the upsert payload:
```ts
score_is_stale: false,
```

## What this fixes (matches user's spec)

- **Resubmit confirmation:** After tapping Yes, the bot now sends `hwIntentReady(...)` ("📌 Modul N topikga o'tish") instead of "already graded". That is the confirmation the student should receive.
- **Teacher notification on resubmission:** Already wired — when the student posts the new file/text in the topic, `handleGroupTopicMessage` calls `notifyTeachersOfSubmission(...)` exactly as for first submissions. No change needed.
- **Grade replacement:** Already wired — the topic upsert clears `score/score_feedback/scored_by/scored_at`, and the teacher grading flow writes the new score (and `TeacherHomework.tsx` resets `score_is_stale = false`). The prior grade is preserved in `previous_attempts` for history; the *current* score becomes the new one.

## Out of scope

- No DB migrations.
- No changes to web UI, RPC, grading flow, stats, or any non-homework-resubmission code path.
- No translation string changes.

## Verification

- Deploy `telegram-bot-webhook`.
- As a graded student: `/vazifalar` → tap "🔁 qayta topshirish" → tap **Ha** → expect "📌 Modul N topikga o'tish" link (no "already graded" message).
- Post a new file/text in the topic → student gets "✅ qabul qilindi" DM, teacher gets "🔁 qayta topshirildi"-style DM via existing `notifyTeachersOfSubmission`.
- Teacher grades → new score replaces old; old snapshot retained in `previous_attempts`.
