## Goal

Tighten `handleGroupTopicMessage` in `supabase/functions/telegram-bot-webhook/index.ts` so that **only image (photo) or video (video / video_note) posts** in a group homework topic are treated as a submission. Text, plain captions, documents, and voice notes must no longer create a submission row, and must not generate student confirmations or teacher DMs.

## Current behavior (bug)

Lines 3419–3439 extract media from the incoming Telegram message. Today:
- `msg.photo` → counted as submission (photo) ✅
- `msg.video` / `msg.video_note` → counted as submission ✅
- `msg.document` → counted ❌ (user wants images/videos only)
- `msg.voice` → counted ❌
- Plain `msg.text` or `msg.caption` with no media → `kind = "text"` and a submission row is still upserted ❌ (root cause of "a dot counts as homework")

Everything downstream — `homework_submissions` upsert, student confirmation DM, `homework_teacher_dm_queue` insert (drained by `notify-homework-submission`) — runs regardless of `kind`.

## Change

In `handleGroupTopicMessage`, after the media extraction block:

1. Define `const isAcceptedMedia = kind === "photo" || kind === "video" || kind === "video_note";`
2. If `!isAcceptedMedia`, short-circuit before the submission upsert:
   - Do **not** insert/upsert into `homework_submissions`.
   - Do **not** enqueue a teacher DM.
   - Do **not** send the student "submission received" confirmation.
   - Optionally react to the original topic message with `👀` (or skip reaction) and DM the student (only if `profile.telegram_id` and only once per intent, to avoid spamming a chatty topic) telling them to send a photo or video.
   - Log `hw:group:rejected-non-media` with `{ profile_id, kind, chatId, threadId, messageId }`.
   - `return;`
3. Leave the rest of the flow (attempt bump, upsert, message URL, teacher DM enqueue, student confirmation, resubmission attempt counter) **completely untouched** — so first submissions and resubmissions keep working exactly as they do today for valid media.

To avoid DM spam when a student writes several text messages in the topic, gate the "please send a photo or video" reminder DM with a short in-memory or `bot_homework_intents`-based throttle: only send the reminder if the most recent reminder for this `(user_id, intent_id or assignment_id)` is older than e.g. 5 minutes. If that adds risk, a simpler v1 is: send the reminder at most once per Telegram message (no dedupe) — still safe because we only DM the sender of the rejected message, not the whole topic.

## i18n

Add three locale strings (uz/ru/en) used only for the rejection DM, e.g.:
- uz: `❗️ Faqat rasm yoki video qabul qilinadi. Iltimos, vazifangizni rasm yoki video sifatida yuboring.`
- ru: `❗️ Принимаются только фото или видео. Пожалуйста, отправьте задание изображением или видео.`
- en: `❗️ Only photos or videos are accepted. Please send your homework as an image or video.`

These live next to the existing `hwIntent*` keys in the same file (no client i18n JSON changes needed — these are bot-side strings).

## Out of scope (explicitly unchanged)

- Submission upsert logic, attempt_number bumping, `score_is_stale` handling
- `homework_teacher_dm_queue` enqueue + `notify-homework-submission` drainer
- Student confirmation DM content/flow
- Resubmission RPC `start_homework_resubmission`
- Web-based homework submission path
- Anonymous-admin filtering, intent synthesis, already-graded short-circuit
- Any database schema, migrations, or RLS

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` — single localized edit inside `handleGroupTopicMessage` (around lines 3419–3470) plus 3 new locale strings.

## Verification

- Send a text-only message ("hi", ".") in a group homework topic as a linked student → no submission row, no teacher DM, student gets the "image/video only" DM, log line `hw:group:rejected-non-media`.
- Send a photo → submission created, student confirmation + teacher DM as before.
- Send a video → same as photo.
- Resubmit with a photo after a prior graded submission → attempt_number bumps and teacher DM fires as before.
- Send a document or voice note → rejected, same as text.
