## Root cause

In `handleGroupTopicMessage` (supabase/functions/telegram-bot-webhook/index.ts, ~line 2634), the intent lookup is:

```ts
let q = admin.from("bot_homework_intents")
  .eq("telegram_chat_id", chatId)
  .eq("telegram_thread_id", threadId)
  .gt("expires_at", nowIso)
  .order("created_at", { ascending: false }).limit(1);
if (profile) q = q.eq("user_id", profile.id);   // ← only filters when profile is found
```

The fallback "match by topic alone" was meant only for Telegram's anonymous-admin proxy bot (`fromId === 1087968824`). But it actually fires for **anyone whose Telegram id is not linked to a profile** — a teacher chatting in the topic, a guest, or any student whose `profiles.telegram_id` isn't set.

Result: while student A has an active intent, if user B posts in the same topic and B has no profile match, the query returns A's intent. The webhook then:
1. Creates/updates a `homework_submissions` row for student A,
2. Stores `telegram_message_id` / `telegram_message_url` pointing to **B's message**,
3. Sends the teacher a DM whose "📌 Topikga o'tish" button links to B's chat instead of A's upload.

This is what the user is seeing: "the image link is not the same."

A second, smaller contributor: when a student sends an album (multi-photo media_group), the first message consumes & deletes the intent, so albums are unaffected by interleaving — but only the first photo's link is stored. The user confirmed that's the desired behavior (one link to the first message).

## Fix (single file, surgical)

`supabase/functions/telegram-bot-webhook/index.ts` — `handleGroupTopicMessage` only.

1. **Tighten the intent match.** Require an identified profile in all non-anonymous cases. Only fall back to "topic-only match" when `isAnon === true` (Telegram's anonymous-admin bot id).

   ```ts
   let q = admin.from("bot_homework_intents")
     .select("...")
     .eq("telegram_chat_id", chatId)
     .eq("telegram_thread_id", threadId)
     .gt("expires_at", nowIso)
     .order("created_at", { ascending: false }).limit(1);

   if (isAnon) {
     // anonymous admin proxy — match by topic alone (legitimate use)
   } else {
     if (!profile) {
       console.log("hw:group:unknown-sender-ignored", { fromId, chatId, threadId, messageId });
       return; // do NOT attribute B's message to A
     }
     q = q.eq("user_id", profile.id);
   }
   ```

2. **Defensive check before upsert.** After resolving the intent, if `!isAnon && intent.user_id !== profile.id`, log `hw:group:intent-user-mismatch` and bail. Belt-and-suspenders against future regressions.

3. **Bump version banner** at the top of the file to `v3.14.36`.

No DB changes, no schema changes, no UI changes. `notifyTeachersOfSubmission` and the deep-link builder (`buildMessageLink`) are already correct — they just need to receive the right `messageId`.

## Behavior after fix

- Student A taps 📤 Topshirish in bot → posts photo in topic → submission saved, link points to **A's** message, teacher DM correct. (unchanged happy path)
- While A's intent is active, anyone else posts in the same topic (teacher, guest, unlinked user) → silently ignored, log `hw:group:unknown-sender-ignored` or `hw:group:no-matching-intent`. **A's submission is not overwritten and the link stays correct.**
- Anonymous admin (`fromId === 1087968824`) posting "as the group" → still works via topic-only fallback (rare but supported).
- Album from A → first photo's link is stored, intent consumed, rest are silently ignored (matches desired outcome).

## Verification

1. **Reproduce pre-fix path manually via logs.** Pick a recent submission whose `telegram_message_url` differs from the student's actual upload — confirm the prior `hw:group:enter` log shows a `fromId` that is NOT in `profiles.telegram_id`.
2. **Post-fix smoke test.**
   - Student does the bot flow, then immediately posts in the topic. Have a second account (teacher / unlinked) post a chat message between the bot tap and the student's photo. Confirm:
     - submission row's `telegram_message_id` matches student's photo,
     - teacher DM "📌 Topikga o'tish" opens student's photo,
     - logs show `hw:group:unknown-sender-ignored` for the interleaving message.
3. **Regression check.** Plain chat in the homework topic with no active intent → still logs `hw:group:no-matching-intent`, no submission created, no teacher DM (per the previous fix).
