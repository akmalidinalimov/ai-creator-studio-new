## Goal

Make it easy for teachers to track submissions per student. Replace the chronological "📑 Baholar" (recent grades) view with a roster-first browser: students → modules → grades.

All changes in `supabase/functions/telegram-bot-webhook/index.ts`. Telegram-only; no DB schema, no web UI.

## New flow

### Level 1 — Student roster (replaces `/baholar`)

Tapping `📑 Baholar` (renamed to `👥 Talabalar`) shows all students in the teacher's active group, paginated 10/page.

Button label per student:
- `@username` if `profiles.telegram_username` exists
- otherwise `First Last` (full name fallback)
- suffix `· N` = total submissions count (graded + pending) so teachers see who's active at a glance

Sort: most submissions first, then alphabetical.

Admins see all students across all groups (same as today's grading scope).

### Level 2 — Per-student module list

Tapping a student shows one row per module they have submitted to:

```
👤 @username (Aziza Karimova)

📦 1-modul — 1 topshirildi · 8/10
📦 2-modul — 1 topshirildi · ⏳ baholanmagan
📦 3-modul — 3 topshirildi · 7/10, 9/10, ⏳

↩️ Talabalar ro'yxati
```

Rules per module row:
- "N topshirildi" = count of submissions (leaves) for that module by this student
- After `·` show each leaf's score in submission order: `8/10`, `9/10`, or `⏳` for ungraded
- If a module has only one task (no SAPs), it collapses to a single score
- Modules with zero submissions are hidden
- Order by `module.position` ascending

Each module row is a tappable button → drills to Level 3.

### Level 3 — Submission detail (per module)

Reuses the existing `renderStudentBreakdown` flow scoped to one module: lists each leaf (V1, V1.S1, V1.S2…) with score, feedback, and a "Grade" button for ungraded ones. Back button returns to Level 2.

## Callback data

New namespace `tr:` (teacher roster) to avoid clashing with `gs:` (existing grading picker):
- `tr:list:<page>` — roster page
- `tr:stu:<userId>` — Level 2 module list for a student
- `tr:mod:<userId>:<moduleId>` — Level 3 submission detail

Existing `gs:` callbacks remain for the "📝 Baholash" flow (no change).

## Code touchpoints

1. **Locale strings** (uz/ru/en blocks ~lines 162/339/508): rename `tKbGraded` from `📑 Baholar` to `👥 Talabalar` / `Студенты` / `Students`. Add new strings: `rosterTitle`, `rosterEmpty`, `rosterStudentRow(name, n)`, `studentModulesTitle(name)`, `moduleSubRow(mn, count, scores)`, `backToRoster`.
2. **Keyboard mapping** (~line 748): `/baholar` text-button now routes to new `renderTeacherRoster` instead of `handleGradingCommand` "scored" branch.
3. **Remove** the `/baholar` recent-grades branch in `handleGradingCommand` (~lines 1946–1962). Keep `/grades` slash-command alias pointing to the new roster too.
4. **Add** `renderTeacherRoster(admin, chatId, graderId, locale, isAdmin, page, groupId)`:
   - Reuse `gradingScopeIds` to get student IDs for the teacher's active group (or all for admin).
   - Query `profiles` for `id, name, last_name, telegram_username` of those IDs.
   - Query `homework_submissions` filtered to those user IDs, group by `user_id` for total counts.
   - Build paginated inline keyboard.
5. **Add** `renderStudentModules(admin, chatId, studentId, locale, …)`:
   - Load student's submissions joined with `homework_assignments(module_id, task_number, sap_number, parent_id, max_score)`.
   - Group by `module_id`; for each module fetch `modules.position, title`.
   - Format each row with submitted count + ordered score list (`score/max` or `⏳`).
6. **Add** `renderStudentModuleDetail(admin, chatId, studentId, moduleId, …)` — thin wrapper around the existing per-leaf rendering used in `renderStudentBreakdown`, filtered to one module.
7. **Callback router** (where `gs:` is dispatched): add `tr:list|stu|mod` cases.

## Out of scope

- No change to the `📝 Baholash` (grading queue) flow.
- No change to student-facing buttons or web UI.
- No DB migrations — `profiles.telegram_username` already exists.

## Verification

1. As a teacher with a group: tap `👥 Talabalar` → roster shows students with `@username` (or full name) and submission counts; pagination works at 11+ students.
2. Tap a student → module rows render in module order, only modules with submissions appear, scores list matches DB.
3. Tap a module row → existing per-leaf detail renders; "Grade" still works on ungraded leaves.
4. As admin: roster shows all students across groups.
5. Empty group → friendly "no students" message; student with zero submissions → not in roster.
