## Issues found (single file: `supabase/functions/telegram-bot-webhook/index.ts`)

### 1. Teacher gets no notification on resubmission

`notifyTeachersOfSubmission` (lines ~3722-3730) throttles DMs:

```ts
// Throttle: skip if we already queued/sent a DM for this same student+assignment in the last 24h
const since = new Date(Date.now() - 24*60*60*1000).toISOString();
const { data: recent } = await admin.from("homework_teacher_dm_queue")
  .select("id").eq("student_id", studentProfile.id).eq("assignment_id", assignmentId)
  .gte("created_at", since).limit(1);
if (recent && recent.length) return;
```

When a student resubmits within 24h (the common case), this hit silently swallows the new submission — teacher gets no DM, no link, nothing in the pending list. This matches the symptom the user reports.

### 2. Feedback comment is truncated to 40 chars

`hwTaskScored` (uz line 240, ru 437, en 634) renders feedback as:

```ts
`   ✅ V${tn}: ${sc}/${mx}${fb ? ` — "${csvEscapeHtml(fb).slice(0, 40)}"` : ""}`
```

This is the listing the student sees in `/galaba` / per-module summary — long comments are cut off mid-sentence. The grading DM (`gradeStudentDM`) already shows the full comment; only this list view trims.

### 3. Submission link

Already correct after the prior `handleGroupTopicMessage` fix — every consumed intent writes `telegram_message_url` from the student's actual post. No change needed; the link will reach the teacher again once #1 is fixed.

## Fix

**A. Replace the 24h "any submission" throttle with a per-submission guard.**

Throttle on `submission_id` instead of `student_id + assignment_id`. This still prevents accidental double-DM for the same submission row (e.g. webhook retries) but always lets a fresh resubmission through:

```ts
const { data: recent } = await admin.from("homework_teacher_dm_queue")
  .select("id").eq("submission_id", submissionId).limit(1);
if (recent && recent.length) return;
```

Result: each new student post that calls `handleGroupTopicMessage` updates `homework_submissions` (same row, new `submitted_at`/`telegram_message_url`/`score_is_stale=false`) and queues a fresh teacher DM with the new topic link and "🎯 Baholash" button. The teacher's pending-grading list (from `tKbGrade` → ungraded query) automatically picks the row back up because the prior `score` was already cleared by the resubmit confirm flow (`hw:resub_yes` sets `score_is_stale=true`, and the upsert in `handleGroupTopicMessage` resets `score=null, scored_by=null, scored_at=null, score_is_stale=false`).

**B. Stop trimming feedback in the task list.**

Remove `.slice(0, 40)` from all three locale variants of `hwTaskScored` so the student sees the full comment. Telegram's 4096-char message cap still bounds the overall message; a single feedback string in practice is well under that.

```ts
// before
hwTaskScored: (tn, sc, mx, fb) => `   ✅ V${tn}: ${sc}/${mx}${fb ? ` — "${csvEscapeHtml(fb).slice(0, 40)}"` : ""}`
// after
hwTaskScored: (tn, sc, mx, fb) => `   ✅ V${tn}: ${sc}/${mx}${fb ? `\n      💬 ${csvEscapeHtml(fb)}` : ""}`
```

(Move feedback to its own indented line so long text wraps cleanly under each task.)

## Out of scope

- No DB migration.
- No changes to `handleGroupTopicMessage`, `startHomeworkIntent`, grading flow, RPCs, web UI, stats, translations beyond the three string templates above, or `notify-homework-submission` cron.
- No changes to quiet-hours behavior, immediate-DM behavior, or audit logging.

## Verification

1. Deploy `telegram-bot-webhook`.
2. Student submits → teacher DM arrives with topic link + "🎯 Baholash" (unchanged).
3. Teacher grades with a long (>40 char) comment → student opens `/vazifalar` → comment renders in full on its own line.
4. Student taps 🔁 qayta topshirish → posts new file in topic → confirm:
   - Student gets ✅ confirmation DM.
   - Teacher gets a NEW DM with the NEW message link + Baholash button.
   - Teacher's pending grading list shows the task again.
   - Teacher grades → previous score is replaced (already covered by existing update path).