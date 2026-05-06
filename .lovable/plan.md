## Root cause

Students do successfully submit homework (rows appear in `homework_submissions`), but the teacher never gets a DM. The submission flow goes through the legacy intent path `handleGroupTopicMessage` in `supabase/functions/telegram-bot-webhook/index.ts`. That path calls:

```ts
await notifyTeachersOfSubmission(admin, profile, intent.group_id, mn, tn, aTitle, messageUrl, subId, moduleId);
// 9 args
```

but the function signature expects 10 params:

```ts
notifyTeachersOfSubmission(admin, studentProfile, groupId, mn, tn, aTitle, messageUrl, submissionId, assignmentId, moduleId)
```

The `assignmentId` argument is missing, so `moduleId` is silently received as `assignmentId` and `moduleId` ends up `undefined`. The subsequent `INSERT` into `homework_teacher_dm_queue` violates the NOT NULL `module_id` constraint and silently fails inside the function's try/catch. Result: queue is empty (verified: 0 rows), `notify-homework-submission` cron has nothing to send, teacher never gets a DM.

(The other path, `autoDetectHomeworkSubmission`, sends teacher DMs synchronously — but in production all current submissions land via the legacy intent path so they never trigger that DM.)

## Fix — `supabase/functions/telegram-bot-webhook/index.ts`

1. **Fix the call signature** at line ~2717 in `handleGroupTopicMessage`:
   ```ts
   await notifyTeachersOfSubmission(
     admin, profile, intent.group_id,
     mn, tn, aTitle, messageUrl,
     subId, intent.assignment_id, moduleId
   );
   ```

2. **Send the teacher DM immediately** (in addition to queuing), so the teacher is notified at the same moment as the student rather than waiting up to ~1 minute for the next cron tick. Approach: after `notifyTeachersOfSubmission` queues the row, also try a direct `sendMessage` to the teacher with the same body + buttons used by the auto-detect path (`hwTeacherBody`, "🎯 Baholash" + "📌 Topikga o'tish"). If the immediate send succeeds, mark the queue row `sent_at = now()` so the cron does not double-send. Reuse the existing teacher RBAC + `notifications_enabled` + quiet-hours checks (skip immediate send during 22:00–08:00 Tashkent so quiet hours still queue for morning delivery).

3. Keep the cron (`notify-homework-submission`) untouched — it remains the safety net for retries / quiet-hours delivery and for any future submission code paths.

## Verification

1. Student submits homework in a topic via the legacy `/vazifalar → 📤 Topshirish` flow.
2. Student gets the existing "✅ Vazifangiz qabul qilindi" DM.
3. Teacher receives a DM "🆕 Yangi vazifa topshirildi …" within seconds, with "🎯 Baholash" + "📌 Topikga o'tish" buttons.
4. Confirm a row appears in `homework_teacher_dm_queue` with `sent_at` populated (not stuck at NULL).
5. Verify quiet-hours window still queues for next morning instead of waking the teacher.
