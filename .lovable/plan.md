## Goal

Replace the teacher "📝 Vazifalar / Задания / Homework" entry (currently a flat student roster) with a **module-based view**, in both the Telegram bot and the web Teacher Homework page. Modules are read from the DB, so adding Module 8 automatically produces a new button.

---

## 1) Telegram bot (`supabase/functions/telegram-bot-webhook/index.ts`)

### Flow

1. Teacher taps `📝 Vazifalar` (or runs `/baholar`).
2. Bot replies with one inline button per module of the teacher's course (Module 1 … Module N), ordered by `modules.position`. Each button shows `📦 Modul X — <title> · ✅ a / 👥 b` where `a` = students who submitted at least one homework of that module, `b` = total students in scope.
3. Tapping a module sends **two messages**:
   - **Message A — "Topshirganlar"**: list of students in the teacher's scope who have at least one submission for that module. Each line = `@username (Full Name) — score/max · 💬 comment` per leaf assignment they submitted. If a submission is not yet graded, show `⏳ baholanmagan` instead of score.
   - **Message B — "Topshirmaganlar"**: list of students in scope with **zero** submissions for that module. Each line = `@username (Full Name)` (or full name if no Telegram username). Includes a `📨 DM` button (Telegram deep link) when `telegram_id` is known so the teacher can contact them.

### Scope

Reuse `gradingScopeIds(admin, graderId, isAdmin, groupId)` to bound students to the teacher's group(s). Modules come from the courses linked to those groups (`groups.course_id` → `modules`). Admins see all modules of all courses.

### Implementation details

- Replace the body of `/baholar` handling (line 2032) so it calls a new `renderTeacherModulePicker(...)` instead of `renderTeacherRoster(...)`. Keep `renderTeacherRoster` reachable via `/talabalar` only (backward-compatible alternative).
- New functions:
  - `renderTeacherModulePicker(admin, chatId, graderId, locale, isAdmin, groupId?)` — query modules for the teacher's course(s), counts submitted vs total students, renders inline buttons with callback `thm:mod:<moduleId>`.
  - `renderModuleSubmittedList(admin, chatId, graderId, moduleId, locale, isAdmin, groupId?)` — sends Message A.
  - `renderModuleMissingList(admin, chatId, graderId, moduleId, locale, isAdmin, groupId?)` — sends Message B with optional `tg://user?id=…` DM button.
- New callback prefix `thm:mod:<moduleId>` — both list messages are sent in sequence; back button `thm:list` returns to the module picker.
- New i18n keys (UZ/RU/EN): `teacherModulesTitle`, `teacherModuleRow(pos, title, submittedCount, totalCount)`, `teacherModSubmittedTitle(modPos)`, `teacherModMissingTitle(modPos)`, `teacherModNoneSubmitted`, `teacherModNoneMissing`, `teacherModBackToList`, `teacherModDmBtn`.
- Pagination: if module count > 8, paginate (`thm:list:<page>`); same for student lists (split into chunks of ~30 per Telegram message; spill over via additional sends).

### Data queries per module click

```text
assignments      = SELECT id, max_score, task_number, sap_number, parent_id
                   FROM homework_assignments
                   WHERE module_id = $1 AND is_active = true;
leaves           = computeLeaves(assignments)   // existing helper
scopeStudentIds  = gradingScopeIds(...)         // existing
submissions      = SELECT user_id, assignment_id, score, score_feedback, submitted_at
                   FROM homework_submissions
                   WHERE assignment_id IN leaves AND user_id IN scopeStudentIds;
profiles         = SELECT id, name, last_name, telegram_username, telegram_id
                   FROM profiles WHERE id IN scopeStudentIds AND archived_at IS NULL;
```

Group submissions by `user_id` to build Message A; profiles with no submissions go to Message B.

---

## 2) Web platform (`src/pages/TeacherHomework.tsx`)

Add a new top-level tab **"Modul bo'yicha"** (next to the existing matrix/pending tabs). UI:

- A grid of module cards (auto from `modules` table). Each card shows module number, title, and `Topshirganlar X / Talabalar Y`.
- Clicking a card opens a sheet with two collapsible sections mirroring the bot:
  - **Topshirganlar** — table: Username · Full name · per-leaf `score/max` · comment.
  - **Topshirmaganlar** — table: Username · Full name · `Telegram` button (deep link if `telegram_id` known).
- Group selector at the top reuses existing `selectedGroup` state to bound the scope.

No new tables, RPCs, or migrations required — all data comes from existing tables (`modules`, `homework_assignments`, `homework_submissions`, `profiles`, `groups`).

---

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` — i18n keys, new render functions, new callback prefix `thm:`, swap `/baholar` to call the module picker.
- `src/pages/TeacherHomework.tsx` — new "Modul bo'yicha" tab + sheet.
- `src/i18n/locales/{uz,ru,en}.json` — labels for the new tab and headings.

## Out of scope

- No DB schema changes.
- No edits to grading flow itself (`gs:open`, score capture) — existing buttons still work and a `📝 Baholash` button can still be surfaced from the submitted list per ungraded submission.
