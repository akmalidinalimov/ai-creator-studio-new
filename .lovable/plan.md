## Problem

Currently any post in the homework topic triggers a submission + teacher DM, because the webhook calls **`autoDetectHomeworkSubmission`** on every group topic message. This function (added in v3.14.32) intentionally bypasses the intent flow — it picks the most recent active assignment from `groups.homework_topic_id` and attributes the post to it, with no requirement that the student first go through the bot.

The bot already has a proper intent-based flow:
- Student opens bot → **"Mini vazifalarim"** → picks module → taps **📤 Topshirish**
- That creates a row in `bot_homework_intents` (user_id + chat + thread + assignment, with `expires_at`)
- `handleGroupTopicMessage` only acts on a topic post when a matching, non-expired intent exists for that user

We just need to stop the auto-detect path and rely solely on the intent-gated path.

## Fix (single file: `supabase/functions/telegram-bot-webhook/index.ts`)

1. **Remove the auto-detect call** in the group/supergroup branch of the webhook handler (~line 3674). Only `handleGroupTopicMessage(admin, msg)` runs.
2. **Keep `recordGroupMessageEvent`** (analytics) untouched — it does not create submissions.
3. **Keep the `autoDetectHomeworkSubmission` function defined** (dead code) for now so we can re-enable easily if needed; just no caller. Add a `// v3.14.35: disabled — intent-only flow` comment.
4. Bump the version banner comment at the top of the file to `v3.14.35`.

No DB migration, no schema change, no UI change. Frontend untouched.

## Behavior after fix

- Student posts in topic without using bot → **silent**, no submission row, no teacher DM. (Will log `hw:group:no-matching-intent` in `handleGroupTopicMessage` — already does today.)
- Student uses bot → "Mini vazifalarim" → picks module → 📤 Topshirish → posts in topic → submission created + ✅ reaction + student confirm DM + teacher DM (unchanged).
- Intent expires (TTL already enforced by `expires_at`) → reverts to silent.

## Verification

1. From a non-onboarded chat, post text in the homework topic → no submission row created, no teacher DM, log shows `hw:group:no-matching-intent`.
2. From a registered student, go through bot flow → post → submission appears, teacher gets DM, ✅ reaction lands.
3. Check `/admin/bot-debug` inbox: pre-fix rows showed `resolved_via=shared_topic`; post-fix unsolicited posts will show no resolution attempt from auto-detect (skipped entirely).