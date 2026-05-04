## Problem

In the bot's "📝 Mening vazifalarim" message, every module currently ends with a raw line like:

```
📌 Topshirish topiki: https://t.me/c/3717100574/126
```

These URLs:
- Look broken/ugly in the chat (long t.me/c/... links, no preview).
- Are redundant — the inline buttons at the bottom of the same message ("📤 Topshirish — M1·V1", "📤 Topshirish — M2·V2", …) already deep-link the student straight to the right topic when they tap **Topshirish**.
- For modules where every task is already graded, the line adds noise with no purpose.

## Proposed replacement

Drop the raw URL line entirely. In its place, show a short, contextual hint per module:

- **If the module has at least one ungraded task and a topic is configured:**
  `👇 Topshirish uchun pastdagi "📤 Topshirish — M{n}·V{k}" tugmasini bosing.`
- **If all tasks in the module are already graded:**
  `✅ Bu modul vazifalari topshirilgan.` (no link, no button needed)
- **If the student's group has no topic configured for this module:**
  Keep the existing `t.hwTopicMissing` warning so admins/teachers still see the misconfiguration signal.

This keeps the message scannable, removes the broken-looking URLs, and relies on the existing inline buttons (which the user confirmed are working) as the single submission entry point.

## Scope of changes

Single file: `supabase/functions/telegram-bot-webhook/index.ts`

1. **Strings (in each `T[locale]` block — uz / ru / en):**
   - Remove `hwTopicLine`.
   - Add `hwSubmitHint(moduleNum, taskNum)` → e.g. uz: `👇 Topshirish uchun pastdagi "📤 Topshirish — M${m}·V${t}" tugmasini bosing.`
   - Add `hwModuleAllDone` → uz: `✅ Bu modul vazifalari topshirilgan.`
   - Keep `hwTopicMissing` as-is.

2. **`buildHomeworkMessage` (around line 1032–1033):**
   Replace the current `lines.push(topic ? t.hwTopicLine(topic) : t.hwTopicMissing);` with logic:
   - Compute `ungraded = m.arr.filter(a => !(subMap.get(a.id)?.score != null))`.
   - If `!topic && groupId` → push `t.hwTopicMissing`.
   - Else if `ungraded.length === 0` → push `t.hwModuleAllDone`.
   - Else → push `t.hwSubmitHint(m.position + 1, ungraded[0].task_number || 1)` (points at the first unsubmitted task; the buttons cover all of them).

3. No DB, schema, button, or callback changes — only message text.

## Out of scope

- Submission flow itself, intent matching, anonymous-admin handling, teacher DMs — all unchanged.
- Web UI (`HomeworkSection.tsx`, `HomeworkProfileSection.tsx`) — unchanged; the URL still belongs there as a real button.

## Deploy / verify

After editing, redeploy `telegram-bot-webhook` and tap the **📝 Mening vazifalarim** button in the bot to confirm the new hint lines render and the existing **📤 Topshirish — M·V** buttons still work.
