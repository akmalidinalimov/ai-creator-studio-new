I reviewed the relevant homework bot, resubmission, teacher notification, grading, and stats code paths.

Key finding: direct group-topic uploads are now correctly ignored. The current weak point is that the submission flow still shows a topic-opening button after the student taps Submit, which makes it easy for students to leave the bot DM and upload in the group topic. Telegram cannot reliably distinguish “opened topic through the bot” from “posted directly in the topic”, so the safest architecture remains: submissions must be sent to the bot private chat, and the bot mirrors them into the topic.

Plan:

1. Make the student submission path unambiguous
   - Remove the “Open topic” button from the active submission prompt.
   - Replace it with a direct in-bot prompt telling the student to attach a photo/video in the bot chat.
   - Add a cancel option so stale submission intents can be cleared cleanly.
   - Keep direct group-topic uploads ignored so casual group chat is never counted as homework.

2. Harden bot-DM media intake
   - Ensure private bot uploads are handled for both normal messages and edited private messages where Telegram may attach media/captions differently.
   - Keep support for photo, video, video note, image documents, and video documents.
   - If an active homework intent exists but the student sends unsupported media, reply with the “photo/video only” reminder.
   - Add clear logs for: intent found, media accepted/rejected, copy-to-topic success/failure, database write success/failure, student confirmation success/failure, and teacher notification queue/send result.

3. Normalize submission and resubmission handling
   - Use one shared submission finalization path for first submissions and resubmissions.
   - On successful upload through the bot DM:
     - copy the media into the configured Telegram topic,
     - write/update the `homework_submissions` row,
     - clear live score fields for a real resubmission so it returns to “waiting for grading”,
     - set `score_is_stale` correctly,
     - preserve previous graded attempts in `previous_attempts`,
     - delete the active intent only after the submission is successfully recorded.
   - Send different student copy for first submission vs resubmission, e.g. “Submission received” and “Resubmission received, waiting for review/grading.”

4. Ensure teacher notifications fire for every successful attempt
   - Queue a teacher DM for every successful first submission and every successful resubmission, even when the same `homework_submissions` row is reused.
   - Keep immediate teacher DM delivery when not in quiet hours, with cron retry via `homework_teacher_dm_queue` if delivery fails or is scheduled.
   - Update teacher message text to indicate whether it is a new submission or a resubmission.

5. Recheck grading/stat dependencies
   - Ensure pending teacher lists treat resubmitted work as pending once the new media is recorded.
   - Ensure student stats continue using the effective-grade rule: current score when graded, otherwise latest previous graded attempt while resubmission is pending.
   - Invalidate the bot reply cache after submission, resubmission, and grading updates so “My homework” and stats reflect the latest state.
   - Verify grade save resets `score_is_stale` to false so statistics and homework status settle after grading.

6. Validate end-to-end
   - Test direct group-topic media upload: no submission row, no student confirmation, no teacher notification.
   - Test first submission through the bot DM: submission row created, student confirmation sent, teacher notification queued/sent, teacher can open/grade it.
   - Test resubmission through the bot DM: previous grade preserved, work returns to pending review, student gets resubmission confirmation, teacher gets resubmission notification, stats remain consistent before and after grading.
   - Inspect function logs and database rows for `homework_submissions` and `homework_teacher_dm_queue` after each test.