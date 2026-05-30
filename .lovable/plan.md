## Problem

In `supabase/functions/telegram-bot-webhook/index.ts → handleGroupTopicMessage` (line ~3317), ANY registered student message in a homework topic currently becomes a submission:

1. Media check (line ~3422) accepts `photo`, `document`, `video`, `voice`, `video_note`, and even falls through on text/caption-only — only fully empty messages are dropped.
2. **Auto-intent synthesis** (line ~3361, "v3.14.40"): if the student never tapped 📤 Topshirish in the bot, the webhook silently fabricates an intent on the fly for any post in the topic and writes a `homework_submissions` row + DMs the teacher.

Result: casual chat ("thanks", questions, stickers, random photos shared with classmates) in groups 1–8 all fire fake submissions and teacher notifications.

## Fix — two gates, both required

A message in a homework topic is a submission **only if BOTH are true**:

1. It is a **photo or video** (per user spec: not text, not document, not voice, not video_note, not sticker, not animation, not caption-only).
2. The sender has an **active `bot_homework_intents` row** they created by going through `/vazifalar → 📤 Topshirish` in the bot DM (i.e. they explicitly chose which assignment to submit).

If either gate fails → ignore silently. No intent synthesis. No submission row. No student ✅. No teacher DM.

### Code changes in `handleGroupTopicMessage`

**A. Strict media gate — first thing after the chat/thread/message-id guard:**

```ts
let fileId: string | null = null;
let kind: "photo" | "video" | null = null;
if (Array.isArray(msg.photo) && msg.photo.length) {
  fileId = msg.photo[msg.photo.length - 1].file_id;
  kind = "photo";
} else if (msg.video) {
  fileId = msg.video.file_id;
  kind = "video";
}
if (!kind) {
  console.log("hw:group:non-media-ignored", JSON.stringify({ chatId, threadId, messageId }));
  return;
}
```

**B. Remove the auto-intent synthesis block (lines ~3361–3413).** Replace it with a strict require:

```ts
if (!intent) {
  console.log("hw:group:no-active-intent-ignored", JSON.stringify({
    profile_id: profile.id, chatId, threadId, messageId,
  }));
  return; // student didn't go through /vazifalar → 📤 Topshirish
}
```

**C. Delete the now-duplicate media-extraction block at lines ~3420–3439.** `kind` / `fileId` are already set by gate A.

**D. Consume the intent on successful submission** (one-shot). After the `homework_submissions` upsert succeeds:

```ts
if (intent.id) {
  await admin.from("bot_homework_intents").delete().eq("id", intent.id);
}
```

This prevents a second post in the same topic from accidentally attaching to the same intent. A resubmission requires the student to tap 📤 Topshirish again — which is the intended UX and matches the user's "submission must go through the bot" rule.

### Student-facing UX (already in place, untouched)

- `/vazifalar → 📤 Topshirish` already DMs: "Tap the button below to open the topic and post your photo or video. The bot will accept it automatically (within 10 minutes)." (line 247 uz, 641 en). The 10-minute window is the existing `bot_homework_intents.expires_at` default.
- If a student posts directly in the topic without using the bot, they get no confirmation — which is now the correct signal that the post was not accepted as homework.

### Grading + stats (unchanged, already correct)

The grading flow (`gs:open:<id>` → `grade_comment`, line ~2743) already:
- Updates `homework_submissions.score / score_feedback / scored_by / scored_at`.
- Calls `cacheInvalidateUser(sub.user_id)` → refreshes `/vazifalar`, `/galaba`, profile DM, admin homework views.
- DMs the student their grade + feedback + magic-link to `/profile`.
- Leaderboard recomputes via the existing `leaderboard-recalc` cron from the updated rows.

Resubmission path remains: new intent → new photo/video post → `attempt_number` bumps, `score_is_stale` resets, `previous_attempts` keeps prior graded attempt, new teacher DM fires (idempotent per fresh `telegram_message_url`).

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` — `handleGroupTopicMessage` only. Net: remove ~50 lines of synthesis, add ~15 lines of gates + intent consume.

No DB migration. No frontend change. No change to grading/stats pipelines.

## Verification

1. Deploy `telegram-bot-webhook`.
2. Group 8 topic, registered student, **no bot flow first**:
   - Send plain text → log `hw:group:non-media-ignored`, no DB write, no DMs.
   - Send a photo → log `hw:group:no-active-intent-ignored`, no DB write, no DMs.
   - Send a document/voice/sticker → log `hw:group:non-media-ignored`, no DB write, no DMs.
3. Group 8, same student goes through `/vazifalar → 📤 Topshirish` for Module X Task Y, then posts a photo in the topic:
   - `homework_submissions` row created with `telegram_message_url`, `telegram_file_id`, `telegram_file_kind='photo'`.
   - Student gets ✅ + "submitted" DM. Teacher gets DM with "📂 Open post" + "🎯 Grade" buttons.
   - `bot_homework_intents` row deleted.
4. Same student posts a second random photo in the topic without re-tapping Topshirish → ignored (no active intent).
5. Student taps Topshirish again for the same assignment and posts a new photo → `attempt_number` bumps, teacher gets a fresh DM.
6. Teacher grades from DM → student grade DM arrives; `/vazifalar` + leaderboard reflect the new score on refresh.