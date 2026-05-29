## Problem

Today's flow:
1. Student taps `/vazifalar` → 📤 Topshirish → bot creates a `bot_homework_intents` row (10 min TTL) and shows a "Topikga o'tish" link to the group topic.
2. Student opens the topic and posts a photo/video.
3. `handleGroupTopicMessage` matches that post against the open intent and records a submission + teacher DM.

The bug the user is hitting: step 1 happens, then they leave the bot and post media directly in the group topic (their own intent is still open, or another student/themselves posts unrelated media). The webhook matches the topic upload to the intent and counts it as a submission, even though the student never actually completed the bot flow.

There is no reliable way to distinguish "media posted because the student tapped the bot's link" vs "media posted by walking into the topic directly" — Telegram doesn't mark posts as coming from a button. As long as we accept group-topic uploads as submissions, casual topic activity will keep getting counted.

## Fix: submission must happen inside the bot DM

Change the submission flow so the photo/video is sent **to the bot in the private chat**, not to the group topic. The bot then mirrors the media into the topic on the student's behalf and records the submission. Group-topic uploads stop being a submission channel entirely.

### New flow

1. Student → bot DM: `/vazifalar` → pick module → 📤 Topshirish.
2. Bot replies in DM: "Send your photo or video here in this chat. I'll post it in the group topic for you." (single attachment, plus optional caption.)
3. Bot creates the same `bot_homework_intents` row, but now scoped to the **DM chat** (no `telegram_thread_id` matching anymore — the intent says "next media this user sends me in DM goes to assignment X").
4. Student sends a photo/video to the bot in DM.
5. Bot:
   - validates it's a photo/video (existing media-only filter from v3.14.42),
   - forwards/copies the media into the group homework topic via `copyMessage` (so the post appears in the topic under the bot, with a caption like `📤 {Student Name} — M{n}·T{n}`),
   - inserts/updates `homework_submissions` (forwarded `telegram_message_id` = the copied message in the topic, so teacher's "View post" button still works),
   - enqueues `homework_teacher_dm_queue`,
   - sends the student the existing confirmation DM,
   - deletes the intent.
6. If the student sends text/other non-media in DM while an intent is open → existing `hwOnlyMedia` reminder.
7. If the student posts anything in the group topic → **completely ignored**, no submission, no DMs.

### Changes in `supabase/functions/telegram-bot-webhook/index.ts`

- **`startHomeworkIntent`** (~lines 3050–3102):
  - Keep intent upsert, but change the user-facing message to: "Send your photo or video here (in this chat). I'll post it in the topic for you. (10 minutes)" in uz/ru/en.
  - Drop the "Topikga o'tish" inline button. (Topic link can stay as a secondary "Open group topic" link for context only — not the submission path.)
  - Still store `telegram_chat_id` / `telegram_thread_id` of the **target topic** in the intent row so we know where to mirror the media.
- **New `handlePrivateHomeworkUpload(admin, msg, profile, locale)`** wired into the private-message router:
  - Look up the active `bot_homework_intents` row for `profile.id` (not expired).
  - If none → ignore (fall through to existing main-menu behavior).
  - Run the existing media-only filter; on non-media send `hwOnlyMedia` and keep the intent.
  - Call Telegram `copyMessage` to the intent's `telegram_chat_id` + `telegram_thread_id`, with a caption identifying the student + assignment.
  - Use the returned `message_id` as the submission's `telegram_message_id`.
  - Insert/upsert `homework_submissions` (same fields as today, including resubmission attempt bump from `existingSub`).
  - Enqueue `homework_teacher_dm_queue`.
  - Send student confirmation DM (existing strings).
  - Delete the intent.
- **`handleGroupTopicMessage`** (~lines 3320–3520):
  - Replace the whole body with: log `hw:group:ignored-not-bot-flow` and return. No intent matching, no submission, no student DM, no teacher DM. (Keeps unknown-sender / anon-admin behavior — all ignored.)
- **i18n** (uz/ru/en blocks):
  - Update `hwIntentReady` / `hwIntentReadyMedia` (or add new keys) to "Send your photo or video here in this chat" wording.
  - Reuse existing `hwOnlyMedia` and confirmation strings.
- **`supabase/config.toml`** — no change.
- **DB schema** — no migration needed; `bot_homework_intents` already has the needed columns.

### Out of scope (unchanged)

- `homework_submissions` schema and `homework_submissions_guard` trigger.
- Resubmission RPC and `score_is_stale` flow.
- `notify-homework-submission` drainer.
- Web-based submission path.
- Admin views.

### Edge cases

- **Multiple open intents per student:** existing `onConflict: "user_id,assignment_id"` means at most one per assignment, but a student could open intents for two different assignments back-to-back. Resolution: at upload time, pick the most recently created non-expired intent and consume that. Reminder DM if multiple are open: not needed — newest wins, matches current UX where 📤 Topshirish replaces context.
- **Group has no configured topic:** still rejected at `startHomeworkIntent` like today (`hwIntentNoTopic`).
- **`copyMessage` fails** (bot not in group, topic deleted, permissions): catch the error, DM the student a friendly "Could not post to the group topic — please contact your teacher" message, do NOT create a submission, keep the intent so the student can retry.
- **Existing in-flight intents created before this deploy:** harmless — they'll just expire after 10 min since group-topic uploads no longer consume them; students will reopen via 📤 Topshirish.

## End-to-end test plan (post-deploy)

Verify via `supabase--edge_function_logs telegram-bot-webhook` plus `homework_submissions` / `bot_homework_intents` reads:

1. **The reported bug:** open intent via bot, leave, post photo directly in topic → log `hw:group:ignored-not-bot-flow`, no `homework_submissions` row, no DMs.
2. **Bot DM happy path:** `/vazifalar` → 📤 Topshirish → send photo to bot DM → bot copies into topic, submission row created, intent deleted, student confirmation DM, teacher DM queued.
3. **Text in DM with active intent:** `hwOnlyMedia` reminder, intent kept, no submission.
4. **Media in DM without active intent:** ignored (falls through to normal menu/no-op).
5. **`copyMessage` failure:** simulate by pointing intent at a chat where bot isn't admin → student gets friendly failure DM, no submission, intent retained.
6. **Resubmission:** teacher grades, student opens new intent, sends new photo in DM → `attempt_number` bumps, score cleared, teacher DM re-enqueued.
7. **Group topic chatter (text, photo, video, anonymous admin):** all silently ignored.
8. **Bot menu smoke:** `/start` → main menu → `/vazifalar` → module list → task list → 📤 Topshirish → confirm intent row has correct `assignment_id`, `module_id`, `group_id`, `telegram_chat_id`, `telegram_thread_id`, future `expires_at`.

If any of (1)–(8) fail, fix in the same loop before reporting back.

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` — update `startHomeworkIntent` wording, add `handlePrivateHomeworkUpload` + private-chat routing hook, gut `handleGroupTopicMessage` to a silent ignore, refresh uz/ru/en strings.
- Then `supabase--deploy_edge_functions` for `telegram-bot-webhook` and run the test plan above.
