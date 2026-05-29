## Problem

Today, when a student posts a photo/video in the group homework topic — even casually, with no intent to submit — the bot still records it as a homework submission. That's because `handleGroupTopicMessage` in `supabase/functions/telegram-bot-webhook/index.ts` (v3.14.40, lines ~3364–3416) **auto-synthesizes a `bot_homework_intents` row on the fly** whenever a known student posts media in a recognized topic. The result: every casual image/video in the topic → submission row + student confirmation DM + teacher DM.

The user wants the opposite behavior: a homework submission may **only** be created when the student deliberately went through the bot flow (`/vazifalar` → 📤 Topshirish), which inserts a real `bot_homework_intents` row. Anything posted in the topic without an active intent must be ignored completely — no submission, no confirmation, no teacher notification, no "please send media" DM.

## Change (single edit, telegram-bot-webhook)

In `handleGroupTopicMessage`:

1. **Remove the v3.14.40 auto-synthesis branch** (the entire `if (!intent) { … synthesized = true; }` block, ~lines 3364–3416). Replace it with:
   ```ts
   if (!intent) {
     console.log("hw:group:no-active-intent-ignored", JSON.stringify({
       profile_id: profile.id, chatId, threadId, messageId,
     }));
     return; // silent — do not DM, do not react, do not record
   }
   ```
2. Drop the now-unused `synthesized` flag and any code paths that depend on it (resubmission attempt-number handling already works off `existingSub`, not `synthesized`, so it stays correct).
3. Keep the rest of the function untouched: media-only filter (v3.14.42), upsert into `homework_submissions`, `homework_teacher_dm_queue` enqueue, student confirmation DM, intent deletion after consumption.

Net behavior:
- Student opens DM with bot → `/vazifalar` → picks module/task → 📤 Topshirish → intent row created, "go to topic" button shown → student posts photo/video in topic → recorded as submission, teacher DM fires, intent deleted. ✅
- Student chats / posts media in topic without first going through the bot → completely ignored, no DM either way, nothing written. ✅
- Student posts text in topic with an active intent → still rejected by the media-only filter from the previous change. ✅
- Anonymous-admin posts, unknown senders → still ignored as today.

## i18n

No new strings. The `hwOnlyMedia` reminder DM stays, but only fires for students who actually opened an intent and then sent non-media. Casual topic chatter no longer triggers it.

## Out of scope (explicitly unchanged)

- `bot_homework_intents` schema and TTL
- Intent creation flow in `/vazifalar` → 📤 Topshirish
- `homework_submissions` schema, `homework_submissions_guard` trigger, resubmission RPC
- `homework_teacher_dm_queue` and `notify-homework-submission` drainer
- Web-based homework submission path
- Admin views (`AdminStudentDetail`, `AdminHomework`)

## End-to-end testing plan

After deploying the edge function, run these checks against the live bot and confirm via `supabase--edge_function_logs telegram-bot-webhook` plus a couple of `supabase--read_query` lookups on `homework_submissions` / `bot_homework_intents`.

1. **No-intent topic media (the bug):** As a linked student, post a photo directly in the group homework topic without touching the bot first.
   - Expect: log line `hw:group:no-active-intent-ignored`, **no** new row in `homework_submissions`, **no** student DM, **no** entry in `homework_teacher_dm_queue`.
2. **Happy path:** In bot DM → `/vazifalar` → pick a module → 📤 Topshirish → tap "Topikga o'tish" → post a photo in the topic.
   - Expect: log `hw:group:auto-intent` is gone; instead a normal consumed-intent flow, a new `homework_submissions` row, intent row deleted, student confirmation DM, `homework_teacher_dm_queue` row enqueued, then teacher DM after the cron runs.
3. **Text-only with active intent:** Open intent via bot, then send "." in the topic.
   - Expect: `hw:group:rejected-non-media` log, `hwOnlyMedia` DM to student, intent row remains for retry, no submission.
4. **Resubmission after grading:** Teacher grades the submission, then student opens a fresh intent and posts a new photo.
   - Expect: `attempt_number` bumps, score cleared, teacher DM re-enqueued.
5. **Already-graded short-circuit removed with synth path:** Posting in topic for a graded assignment **without** an intent → now just `hw:group:no-active-intent-ignored` (no ✅ reaction, no DM). This is the intended new behavior.
6. **Anonymous-admin post / non-student post:** Unchanged — `hw:group:unknown-sender-ignored`.
7. **Button-level smoke (bot DM):** Walk `/start` → main menu → `/vazifalar` → module list → task list → 📤 Topshirish; confirm each callback returns the expected screen and the intent row is created with correct `assignment_id`, `module_id`, `group_id`, `telegram_chat_id`, `telegram_thread_id`, and a future `expires_at`.

If any of (1)–(7) fail, fix in the same loop before reporting back.

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` — remove auto-synthesis block in `handleGroupTopicMessage` (~lines 3364–3416), add silent-ignore early return.

Then `supabase--deploy_edge_functions` for `telegram-bot-webhook` and run the test plan above.
