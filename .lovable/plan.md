## Goal

Whenever a registered student posts in the homework topic, the bot immediately:
1. ✅ reacts on their post,
2. DMs the student "Your homework was submitted",
3. DMs the teacher with "Open post" + "🎯 Grade" buttons,
4. Stores the row in `homework_submissions`.

Other students' posts in the same topic must NOT be attributed to anyone else's pending submission. Anonymous-admin posts and unregistered senders stay ignored. This applies uniformly to all 8 groups (shared-topic groups 4–8 and per-module groups 1–3).

## Approach: auto-synthesize the intent when missing

The existing `handleGroupTopicMessage` already enforces strict per-sender attribution: it only looks up an intent **for the sender's own profile id**, and ignores anonymous posts and unknown senders. That is exactly the attribution model the user wants — we just need it to work without the student first tapping "📤 Topshirish" in /vazifalar.

The fix: when no active `bot_homework_intents` row exists for that sender in that chat+thread, synthesize one in-memory by reusing the resolution logic already present in `autoDetectHomeworkSubmission` (shared-topic + per-module fallback + leaf assignment picker). Then continue down the existing handler so the student/teacher messaging is identical to the manual-intent path.

Because resolution is keyed on `(sender profile id, chat_id, thread_id)`, a second student posting in the topic while the first is still mid-upload only ever creates a submission for the *second* student. There is no shared queue and no last-writer-wins.

## Edits

All in `supabase/functions/telegram-bot-webhook/index.ts`. No DB migration, no UI change.

1. **New helper `resolveAssignmentForTopic(admin, group, threadId, profileId)`** — extracted from `autoDetectHomeworkSubmission`:
   - If `group.homework_topic_id === threadId` → shared-topic mode: load all active leaves across the group's course, pick the next un-graded leaf for *this student* (preferring oldest), fall back to most-recent leaf if all are graded/none pending.
   - Else look up `group_module_topics(group_id, telegram_topic_id=threadId)` → per-module mode: pick the next un-graded leaf in that module for this student.
   - Returns `{ moduleId, assignment, resolvedVia }` or `null`.

2. **`handleGroupTopicMessage`** (line 3249): after the existing strict checks (sender resolved, not anon, not bot), when the intent query returns nothing:
   - Call `resolveGroupFromChatId(admin, chatId)` (already exists).
   - Load the group row (id, name, teacher_id, course_id, homework_topic_id).
   - Call `resolveAssignmentForTopic`. If it returns null → log `hw:group:no-assignment-for-topic` and return silently (preserves today's behavior for unconfigured topics).
   - If the chosen assignment is already graded for this student → react ✅ but DM the student "✅ Bu vazifa allaqachon baholangan" instead of creating a duplicate row. No teacher DM.
   - Otherwise build a synthetic intent object `{ user_id: profile.id, assignment_id, module_id, group_id }` and fall through to the existing upsert/react/DM/teacher-notify block. Do NOT persist it to `bot_homework_intents` (no point — it's consumed in the same call).

3. **Disable the now-redundant intent-only short-circuit** at line 4382: remove the `skip_reason: "intent_only_mode"` log line and the dead `autoDetectHomeworkSubmission` function (lines 3408–3775) to keep one canonical path. The strict attribution lives entirely in `handleGroupTopicMessage`.

4. **Group-resolution coverage check** (`resolveGroupFromChatId`, ~line 3105): verify all 8 chat ids match. Pattern 2 already checks `telegram_group_url` containing the stripped chat id; for the 5 groups whose `telegram_group_url` is an invite link (`https://t.me/+...`) the recent fallback added in the previous loop matches via `homework_topic_url ILIKE '%/c/{stripped}/%'`. All 8 group `homework_topic_url`s contain the stripped chat id, so attribution is guaranteed.

5. **Idempotency / duplicate-post safety**: the upsert key remains `(user_id, assignment_id)` and `attempt_number` is already bumped on each consumed post, so a student posting two photos in a row updates the same row to the latest post URL. Add a 60-second in-memory dedupe per `(profile.id, assignment_id)` so two messages within 60s do not double-DM the teacher.

6. **Teacher DM throttle**: `notifyTeachersOfSubmission` already queues to `homework_teacher_dm_queue` which the cron drains within a minute. Today's DB confirms it sends in <300ms when scheduled_for is `now()`. No change needed.

## Verification

After deploying `telegram-bot-webhook`:
- Have a registered student in group 8 post a photo in the homework topic *without* tapping 📤 Topshirish first. Expect: ✅ reaction within ~1s, student DM "Vazifangiz topshirildi…", teacher DM with "📂 Topshirgan postni ko'rish" + "🎯 Baholash". New row in `homework_submissions` with `source=telegram_topic`.
- Repeat for groups 1, 3, 5, 7 to cover both per-module and shared-topic configurations.
- Two students post simultaneously in the same topic → two distinct submissions, each attributed to its own sender, two separate teacher DMs.
- Anonymous-admin post → ignored (existing guard).
- Already-graded student posts again → DM "Bu vazifa allaqachon baholangan", no new submission, no teacher DM.
- Check `supabase--edge_function_logs` for `hw:group:enter` / `hw:group:auto-intent` lines and confirm no `no-matching-intent` silent-drop entries for legitimate student posts.

## Out of scope

- No changes to /vazifalar → 📤 Topshirish — that path keeps working as a backup for students who prefer the guided flow.
- No changes to `weekly-admin-topic-check`, `notify-homework-submission`, or the grading callbacks.
- No DB migration, no UI changes.

## Summary for the user

Right now the bot only treats a topic post as a homework submission if the student first taps "📤 Topshirish" in /vazifalar. The fix makes the bot recognize any registered student's post in the configured homework topic as that student's submission, while keeping the strict rule that one student's post can never be attributed to another student. After the fix, students post in the topic and immediately see ✅ + a DM confirmation, and the teacher gets a DM with a "Grade" button — for all 8 groups, with no per-module setup required.
