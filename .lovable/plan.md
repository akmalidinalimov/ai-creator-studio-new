## The bug

`handleGroupTopicMessage` in `supabase/functions/telegram-bot-webhook/index.ts` already filters intents by `user_id = sender's profile.id` for normal posters — so a known student's random message in the topic cannot consume another student's pending intent.

The remaining leak is the **anonymous-admin proxy** branch (lines 3199–3207, 3229–3233):

```ts
if (isAnon) {
  // anonymous admin proxy — match by topic alone (legitimate use)
} else {
  if (!profile) { return; }
  q = q.eq("user_id", profile.id);
}
```

When a teacher/admin posts in the topic "as the group" (Telegram's anonymous admin mode, sender id `1087968824`), the handler can't tell who actually sent it, so it falls back to "match the most recent active intent in this topic." That intent belongs to whichever student last tapped 📤 Topshirish — so the admin's message text/file/link gets stamped onto that student's `homework_submissions` row, the intent is consumed, and the student's later real submission no longer matches any intent.

The user's symptom ("someone else posts → it is assigned to the homework link, every student should have their own") is exactly this anonymous-admin case (and is the only remaining unattributed-sender path).

## Fix (single file: `supabase/functions/telegram-bot-webhook/index.ts`, `handleGroupTopicMessage` only)

Drop the anonymous-admin fallback. A submission must come from the student themselves; if we can't identify the sender, we must not attach the message to anyone.

1. **Remove the `isAnon` branch** — always require an identified profile and always filter intents by `user_id = profile.id`. Anonymous-admin posts in the topic are silently ignored (logged for debugging).

   ```ts
   if (!profile) {
     console.log("hw:group:unknown-sender-ignored", { fromId, isAnon, chatId, threadId, messageId });
     return;
   }
   q = q.eq("user_id", profile.id);
   ```

2. **Remove the now-dead "resolve profile from intent" block** (lines 3216–3228) — profile is always present past the guard above.

3. **Keep the existing defensive `intent.user_id !== profile.id` check** as belt-and-suspenders.

4. **Tighten the message-type guard** (already mostly there): only consume the intent when the message carries actual submission content — `photo`, `document`, `video`, `voice`, `video_note`, or non-empty `text`/`caption`. A bare service message (e.g. forum-topic-edited, pin, join) must early-return *before* we touch the intent. Today the guard at line 3252 returns only when none of the media fields and no text exist, which is correct, but I'll also explicitly skip when `msg.text` and `msg.caption` are both empty/whitespace AND no fileId — same effect, just clearer.

That's the entire fix. No DB migration, no other code paths touched.

## What this guarantees

- Only a message **from the student who created the intent** can consume that intent and become their submission link.
- Admin/teacher messages in the topic (anonymous or identified) never overwrite a student's pending submission.
- An unidentified sender (no profile match on `telegram_id`) never consumes any intent.
- If the student never posts within the 10-minute TTL, the intent simply expires — no other person's message can claim it.
- Existing resubmission flow, teacher-DM notifications, grading flow, and stats are untouched.

## Out of scope

- No changes to `startHomeworkIntent`, RPCs, web UI, grading, stats, or translations.
- No DB migration.
- The legitimate use case of a teacher posting "as the group" is preserved as a normal topic message — it just no longer auto-attaches to a student.

## Verification

1. Deploy `telegram-bot-webhook`.
2. Student A: `/vazifalar` → 📤 Topshirish → tap topic link → **does not post**.
3. Have a teacher post in the same topic (both as themselves and "as the group" via anonymous admin). Confirm:
   - No `homework_submissions` row for Student A is updated.
   - The intent row for Student A is still present (not consumed).
   - Edge function logs show `hw:group:unknown-sender-ignored` (anon) or `hw:group:no-matching-intent` (other student).
4. Student A then posts their real submission → it attaches correctly, intent is consumed, teacher gets the DM, link points to Student A's actual message.
5. Repeat with two students A and B both holding open intents in the same topic — each student's own post resolves to their own intent.
