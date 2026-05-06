## Goal

When the teacher sees the "📌 Topikga o'tish" button in Telegram, link it to the **student's submission message** (deep link) instead of just the module's topic root, so one click jumps right to the homework post.

The submission's deep link is already captured in `homework_submissions.telegram_message_url` (set on lines ~2664 and ~2869 of `telegram-bot-webhook/index.ts` whenever a student posts homework in the topic). We just need to use it where the topic URL is currently used.

## Changes — `supabase/functions/telegram-bot-webhook/index.ts`

1. **Teacher DM on new submission (line ~2950)**
   - Already has `messageUrl` in scope. Confirm the URL passed to the "📌 Topikga o'tish" button is the submission `messageUrl`, not the topic URL. (Currently it already uses `messageUrl` — verify and keep.)

2. **Grade-student breakdown view (`gs:student:` flow, lines ~1977–2009)**
   - Today: one "📌 Modul N topikga o'tish" button per module that links to `group_module_topics.telegram_topic_url`.
   - Change: also fetch each pending submission's `telegram_message_url`. For each task row, render an additional inline button "📌 V{n} postga o'tish" that links to the submission's `telegram_message_url` when present. Keep the per-module topic button as fallback only when none of the submissions in that module have a message URL.

3. **Grade single submission view (`gs:open:` → `openGrading`, lines ~2020–2042)**
   - Already shows a "📂 Faylni ko'rish" button using `sub.telegram_message_url`. Add a second button **"📌 Topshirilgan postga o'tish"** with the same URL (clearer label matching the user's request) and only fall back to the module topic URL if the submission has no `telegram_message_url`.
   - Add a new locale string `gradeOpenSubmissionPostBtn` ("📌 Topshirilgan postga o'tish" / RU / EN) in the three locale blocks (lines ~197, ~372, ~539).

4. **Fallback resolver helper**
   - Small helper `resolveJumpUrl(submission, topicUrl)` that returns `submission.telegram_message_url || topicUrl`, used in the two breakdown/grading sites for consistency.

## Out of scope

- Web UI (HomeworkSection, TeacherHomework) is unchanged — the user's request is specifically about the Telegram teacher button.
- Database schema unchanged; data is already captured.

## Verification

1. Student submits homework as photo/document in the group topic → teacher gets DM with "📌 Topikga o'tish" → clicking opens the exact submission message (already works; confirm).
2. Teacher runs `/grade` → picks student → opens module breakdown → each pending task has a button that jumps directly to that submission's post.
3. Teacher taps "🎯 Baholash" on a task → grading view shows "📌 Topshirilgan postga o'tish" button linking to the submission message URL.
4. If a submission lacks `telegram_message_url` (legacy/web), the button falls back to the module's topic URL.
