Findings from the current code/data:

- The core webhook path exists: topic posts are turned into `homework_submissions`, students should get a DM, and teachers should get a DM.
- Recent data shows this path is working for other groups and queues teacher DMs, but Group 8 has no recent webhook inbox rows for its chat id, which means the bot is likely not receiving Group 8 topic posts at all, or they are arriving in a format the handler does not log/consume.
- The notification code has a reliability bug: Telegram `sendMessage` failures are not checked consistently. If Telegram returns an error response, the code can still mark the teacher queue row as sent and silently skip the student confirmation.
- The current auto-submit path dedupes synthesized teacher notifications in-memory for 60 seconds by student+assignment. That can suppress valid quick resubmissions/album uploads and is not reliable across Edge Function instances.
- The resubmission path starts correctly from `/vazifalar`, but automatic topic posting currently blocks already-graded submissions unless the resubmission was explicitly started, so we should keep that behavior but make confirmation/notification reliable when a resubmission is active.

Implementation plan:

1. Add reliable Telegram send handling
   - Add a small helper around Telegram API calls for homework confirmations/teacher notifications that checks `response.ok` and Telegram `{ ok: true }`.
   - If student DM fails, log the exact Telegram error instead of silently ignoring it.
   - If immediate teacher DM fails, leave the queue row unsent so the cron notification function can retry instead of marking it as delivered.

2. Fix teacher notification delivery status
   - Update `notifyTeachersOfSubmission` in `telegram-bot-webhook` so it only sets `sent_at` after Telegram confirms success.
   - Keep the fallback queue behavior intact for quiet hours and failed sends.
   - Align the separate `notify-homework-submission` queue drainer with the same button format and success/error handling.

3. Fix confirmation/resubmission behavior
   - Remove or narrow the 60-second in-memory teacher-DM suppression so valid resubmissions always notify the teacher.
   - Keep idempotency based on the actual message URL/submission row so Telegram retries do not duplicate notifications, but new message posts/resubmissions do notify.
   - Ensure student confirmation is sent after both first submissions and active resubmissions.

4. Strengthen Group 8 intake diagnostics
   - Add explicit logs/resolution states for: group resolved, assignment resolved, submission upserted, student DM sent/failed, teacher DM queued/sent/failed.
   - Ensure `webhook_inbox` records enough detail for Group 8 topic posts so we can distinguish “bot never received the message” from “bot received but ignored it”.

5. Verify all groups’ setup and dependencies
   - Query all groups for shared homework topic URLs, topic ids, assigned teacher, teacher Telegram id, and student Telegram coverage.
   - Confirm Group 8 shared topic id `3` and its teacher are configured.
   - After code changes, deploy `telegram-bot-webhook` and `notify-homework-submission`, then verify logs/data for a fresh Group 8 submission and a resubmission: submission row created/updated, student confirmation attempted successfully, teacher queue row created, and teacher DM sent or left retryable with a real error.

Important note:

If Group 8 still produces no webhook inbox rows after deployment, the remaining issue is Telegram-side setup: the bot is not receiving messages from that group/topic. In that case the code will surface it clearly, and the fix will be to add the bot to Group 8 with message visibility/admin permissions or refresh the webhook allowed updates.