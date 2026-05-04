## Problem

Today, when a student opens the bot → "📝 Mening vazifalarim" → taps the topic link and posts an image in the Telegram group topic, **nothing happens server-side**:

- The bot only renders module headers + topic URLs. It never tells the student "I'm waiting for your file" and never records intent.
- The bot webhook only handles `update.message` from **private chats** (it assumes `msg.from` is the user). It does NOT process `message_thread_id` posts inside the supergroup, so files dropped in topics are invisible to us.
- `homework_submissions` rows are only created when a student submits via the **website** (`HomeworkSection.tsx`).
- Result: teacher's "📝 Vazifalar" picker (`renderStudentPicker`) finds 0 ungraded rows, and the student gets no notification, no link to their file.

## Goal (v3.15 — Bot-first homework submission)

Make the bot the **only path** for homework. After the student goes through the bot's submission flow, drops media in the topic, the bot must:

1. Detect that media post in the group topic, link it to the right student + assignment.
2. Create a `homework_submissions` row containing a re-openable Telegram link to the original message (e.g. `https://t.me/c/<chat>/<thread>/<msg>`).
3. DM the teacher(s) of that student's group: "🆕 New submission from X · Modul Y · Vazifa Z" with an inline button "📂 Open file" (deep-links to the message) and "🎯 Grade now".
4. Show the submission in the teacher's existing `📝 Vazifalar` picker, with the file link appearing inside `startGradingFlow`.

## Implementation Plan

### 1. DB migration — add submission intake state + media link columns

- **New columns on `homework_submissions`** (nullable, additive — keeps website flow working):
  - `telegram_chat_id bigint` — supergroup chat id (e.g. `-100...`)
  - `telegram_thread_id integer` — topic id
  - `telegram_message_id integer` — the post containing the file
  - `telegram_message_url text` — pre-built `https://t.me/c/<chat-without-100>/<thread>/<msg>` link
  - `telegram_file_id text` — Telegram `file_id` for largest photo / document / video (so we can re-fetch later)
  - `telegram_file_kind text` — `photo` | `document` | `video` | `voice` | `text`
  - `source text default 'web'` — `'web'` (legacy) or `'telegram_topic'`
- **New table `bot_homework_intents`** — short-lived (10 min) "I'm about to post" markers so we can attribute the next file the student posts in a topic to the right assignment:
  - `id uuid pk`, `user_id uuid`, `assignment_id uuid`, `module_id uuid`, `group_id uuid`, `telegram_chat_id bigint`, `telegram_thread_id int`, `expires_at timestamptz`, `created_at timestamptz`
  - Unique on `(user_id, assignment_id)` where not expired (we just upsert).
- **Index** on `homework_submissions(telegram_chat_id, telegram_message_id)` to dedupe.
- **RLS**: admin-all on `bot_homework_intents`; existing `homework_submissions` policies already cover the new columns.

### 2. Bot — student "Submit Homework" flow (per-assignment, not per-module)

In `buildHomeworkMessage` (today just text), change the student `/vazifalar` view to **interactive**:

- Group by module. For each **unscored** assignment that has a `topicMap` URL, render an inline button:
  ```
  📤 Topshirish — Modul N · V{task_number}
  ```
  `callback_data: hw:start:<assignment_id>`
- Already-graded assignments stay as text (`✅ scored`).

New callback `hw:start:<assignment_id>`:
1. Fetch assignment + module + student's group → resolve `group_module_topics.telegram_topic_url` and parse out `chat_id` + `thread_id`.
2. Upsert a row into `bot_homework_intents` with `expires_at = now() + 10 min`.
3. Reply with: "📤 Modul N · Vazifa Z uchun rasm/video tayyorlang. Quyidagi tugmani bosib topikga o'ting va faylni shu yerga yuboring. Yuborgach, bot avtomatik qabul qiladi." + inline button `📌 Topikga o'tish` (the topic URL).

If no topic URL configured → reply "Ustozingiz topikni sozlamagan. Iltimos, ustozga murojaat qiling." and do not create intent.

### 3. Bot — handle messages posted **inside the group topic**

Today the webhook ignores group messages. Add a branch at the top of `Deno.serve` message handling:

```
if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') {
  await handleGroupTopicMessage(admin, msg);
  return ack();
}
```

`handleGroupTopicMessage(msg)`:
1. Need `msg.message_thread_id` and `msg.from.id`. Skip if either missing.
2. Look up profile by `telegram_id = msg.from.id`. Skip if unknown.
3. Look up the most recent **non-expired** intent for that user where `telegram_chat_id = msg.chat.id` AND `telegram_thread_id = msg.message_thread_id`. If none → silent no-op (don't spam the group).
4. Extract media:
   - `photo` → take largest `photo[photo.length-1].file_id`, kind=`photo`
   - `document` → `document.file_id`, kind=`document`
   - `video` → `video.file_id`, kind=`video`
   - `voice` → `voice.file_id`, kind=`voice`
   - else → if intent allows text-only, fall back to `kind='text'`; if media required, ignore.
5. Build `telegram_message_url`:
   - For supergroups, `chat.id` is `-100xxxxxxxxxx`. Strip the `-100` prefix → `xxxxxxxxxx`.
   - URL: `https://t.me/c/<stripped>/<thread_id>/<message_id>`
6. **Upsert** into `homework_submissions` (unique key `(user_id, assignment_id)` already implied via existing schema; if not, use `telegram_chat_id+telegram_message_id` to dedupe). Set:
   - `submitted_text = msg.caption || msg.text || ''`
   - `telegram_*` cols + `source='telegram_topic'`
   - `score = NULL`, `submitted_at = now()`
7. Delete the consumed intent.
8. **React in-thread** with a ✅ reaction (`setMessageReaction` via Bot API) so student knows it was captured. Cheap, no extra message.
9. **DM the student** privately: "✅ Vazifangiz qabul qilindi · Modul N · V{n}. Ustoz baholaganidan keyin natija keladi."
10. **Notify teachers** of the student's group:
    - Resolve `groups.teacher_id` for the student's `group_id`. Also include all admins (optional toggle, default off to avoid spam).
    - Look up teacher's `profiles.telegram_id`.
    - DM each teacher: `🆕 Yangi topshiriq\n👤 {Student}\n📚 Modul {N} · V{n} — {assignment.title}` with inline buttons:
      - `📂 Faylni ko'rish` → url = `telegram_message_url`
      - `🎯 Hozir baholash` → callback_data = `gs:open:<submission_id>` (reuses existing grading flow)

### 4. Bot — teacher "Vazifalar" picker shows submissions with file link

`startGradingFlow` already fetches `submitted_image_url` (legacy storage path). Extend it:

- If `submission.telegram_message_url` present → send "🔗 Fayl: <url>" message (or include as inline button alongside the score prompt).
- Keep the existing `homework_images` storage signed-URL path for legacy web submissions.
- Existing `renderStudentPicker` and `renderStudentBreakdown` work as-is — once rows exist, they appear automatically.

### 5. Telegram setup — webhook must receive group messages

The bot is already set as a webhook (uses `WEBHOOK_SECRET`). For it to receive supergroup posts:

- The bot must be an **admin** (or at least a member with "read all group messages" — easiest: admin) of each group whose topics are used.
- The webhook's `allowed_updates` must include `"message"` (default). No code change needed if the webhook was registered with default updates; if it was registered with `allowed_updates=["message","callback_query"]` we're fine.
- **Action item for user**: confirm the bot is added as admin to the supergroup. We'll surface a one-time admin diagnostic banner in `/admin/groups` if `telegram_group_url` is set but we've never received a message from that chat (nice-to-have, not blocking).

### 6. Edge cases & guards

- **Duplicate submissions**: if student posts 3 photos as an album, Telegram sends 3 separate `message` updates. We dedupe by upserting on `(user_id, assignment_id)` — last file wins. (Acceptable per current product behavior; album handling can come later.)
- **Wrong topic**: if intent's `thread_id` ≠ message's `message_thread_id`, ignore. Student can simply tap the button again from the bot.
- **Intent expiry (10 min)**: if expired, the file in the topic is silently ignored (no DB write, no notify) — matches the rule "must go through the bot".
- **No teacher assigned**: skip teacher DM, still record submission so admins see it.
- **Already graded**: if `score IS NOT NULL`, allow re-submission only if assignment policy permits — for v1 we **block** with a private DM "Bu vazifa allaqachon baholangan". (Matches existing UX.)
- **Privacy**: never echo the student's media into private chats; teacher gets a link only.

### 7. Smoke test additions to `docs/smoke-test-v3.14.md` → bump to v3.15

- Bot: "📝 Mening vazifalarim" shows per-assignment submit buttons.
- Tapping `📤 Topshirish` creates a row in `bot_homework_intents`.
- Posting a photo in the matching topic within 10 min creates a `homework_submissions` row with `source='telegram_topic'` and a non-null `telegram_message_url`.
- The teacher of that student's group receives a DM with the file link button.
- Teacher's "📝 Vazifalar" picker shows the new student; opening it shows the file link.
- Posting in the topic without first tapping the bot button: nothing happens (silent ignore).

### Files touched

- `supabase/migrations/<new>.sql` — new columns + `bot_homework_intents` + indexes + RLS.
- `supabase/functions/telegram-bot-webhook/index.ts`:
  - `buildHomeworkMessage` → returns `{ text, keyboard }` (or new sibling that builds keyboard).
  - New `handleGroupTopicMessage`, `notifyTeachersOfSubmission`, helpers `parseTopicUrl`, `buildMessageLink`, `setMessageReaction`.
  - New callback prefix `hw:start:`.
  - Webhook handler: route group/supergroup updates to `handleGroupTopicMessage`.
  - `startGradingFlow`: include `telegram_message_url` if present.
- `docs/smoke-test-v3.15.md` — new file (or append section).

## Out of scope (future)

- Album / multi-file submission (collect all photos in 30s window).
- Resubmission after grading.
- File mirroring to Supabase Storage (we keep the Telegram link only — saves storage and is sufficient for grading).
- Auto-detection of the bot's admin status in the group.

## Commit message

`v3.15 — Bot-first homework submission (intent + group topic capture + teacher notify with file link)`
