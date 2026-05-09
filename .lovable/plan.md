## Goal

Give teachers (and admins) a student-grade matrix on the website: rows = students, columns = modules, each cell shows submission status with the per-task score list. Lives at `/teacher/homework` as the new default view; existing Pending/Scored review queue stays as a secondary tab.

## New default view: "Talabalar" (Students)

```
[Group: Group A ▾]                                       [Pending] [Scored]

Student            | 1-modul         | 2-modul     | 3-modul                  | …
-------------------|-----------------|-------------|--------------------------|----
Aziza Karimova     | ✅ 8/10         | ⏳ —/10     | ✅ 8, 9, ⏳              |
Bek Tursunov       | — not submitted | ✅ 10/10    | ⏳ ⏳, ⏳                 |
```

Cell format (Status + score list):
- Module with one task: `✅ 8/10` (graded), `⏳ —/10` (submitted, ungraded), `— not submitted`
- Module with SAPs (multiple leaves): each leaf rendered in submission order as `8`, `9`, or `⏳`, joined by `, `, prefixed with `✅` if all graded, `⏳` if any pending, `—` if none submitted
- Cells are tappable → opens the existing per-leaf detail Sheet (reuses the `open` Sheet pattern already in TeacherHomework) scoped to that student + module

## Group dropdown
- Teacher: lists groups where `groups.teacher_id = user.id`; default = first; persists active selection in component state only.
- Admin: lists all groups; first option `All groups` (flattens scope).
- Empty state: "No groups assigned" / "No students in this group".

## Page structure (`src/pages/TeacherHomework.tsx` refactor)

Tabs reorder + rename:
1. **Talabalar** (new, default) — the matrix
2. **Pending** — current pending queue (unchanged logic)
3. **Scored** — current scored list (unchanged logic)

Group selector sits above the Tabs and applies to all three tabs (replaces today's implicit "all groups for this teacher" scope).

## Data fetching

For the selected group:
1. `profiles` where `group_id = selectedGroupId` → students (id, name, last_name).
2. `modules` joined via `courses` → ordered by `position`. Use the course tied to the group (`groups.course_id`); fallback to all modules if null.
3. `homework_assignments` where `module_id IN (...)` AND `is_active = true` → know the leaves per module (parent task + SAPs). Compute `maxScore` per module = sum of leaf `max_score` (or single task max).
4. `homework_submissions` where `user_id IN students` AND `assignment_id IN leaves` → group by `(user_id, module_id)` then order by `task_number, sap_number, submitted_at`.
5. Build a `Map<userId, Map<moduleId, LeafResult[]>>` and render.

All queries already permitted by existing RLS (`hws own select` allows teachers; `hwa read auth`; `profiles` teacher access already used today).

## UI components

- Reuse `@/components/ui/table` (already in project) with sticky first column and horizontal scroll for many modules.
- Cell click → open existing `Sheet` with the leaf list filtered to that student+module. Reuse current grading form (score input + feedback + Save) — no behavior change.
- Sort students alphabetically by `last_name, name`; show `last_name name` (full name; no @username here, this is the website).

## Out of scope

- No DB migrations.
- No changes to the Telegram bot.
- No changes to Pending/Scored grading logic — only the wrapper (group selector + new default tab).
- No CSV export (can be a later iteration).

## Verification

1. Teacher with one group → Talabalar tab loads by default; matrix shows every student in that group as a row, every module as a column.
2. Module with SAPs renders comma-separated leaf scores in correct order; ungraded leaves show ⏳.
3. Student who never submitted to a module shows `— not submitted`.
4. Group dropdown switches scope across all three tabs.
5. Admin sees `All groups` + per-group options; "All groups" flattens students with a Group column shown.
6. Clicking a cell opens the existing Sheet with the right leaves; grading still saves and refreshes.
