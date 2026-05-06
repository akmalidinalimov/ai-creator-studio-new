## Goal

Give admins and teachers visibility into per-module homework submission rates per group, both in the web Groups UI and in the Telegram bot (replacing the teacher's "🩺 Guruh holati" button).

## Submission rule

A student "submitted" a module if they have **at least one row** in `homework_submissions` for any active assignment under that module (graded or not).

## 1. New RPC: `admin_group_module_submissions`

Returns one row per (group, module) with submission counts, callable by admin and by teachers (for groups they own).

```sql
CREATE OR REPLACE FUNCTION public.admin_group_module_submissions(
  p_caller_profile_id uuid DEFAULT NULL
)
RETURNS TABLE (
  group_id uuid,
  module_id uuid,
  module_position int,
  module_title text,
  total_students int,
  submitted_count int
)
-- security definer, search_path=public
-- auth: admin sees all; teacher sees only groups where teacher_id = caller
```

Logic per (group, module): count distinct profiles in the group with at least one `homework_submissions` row for any `homework_assignments` (active) belonging to that module. `total_students` = non-archived profiles in group.

## 2. Admin/Teacher Groups page (`AdminGroups.tsx`)

Add a new column **"Vazifalar bo'yicha"** showing a horizontal mini bar row, one chip per module:

```text
M1 ████░ 14/20   M2 ██░░░ 6/20   M3 ░░░░░ 0/20   M4 ─
```

- Each chip: `M{n}` label + tiny progress bar (color: `bg-primary` fill, `bg-muted` track) + `submitted/total`.
- Hover/tooltip = module title + percentage.
- Empty/no-active-assignment modules render as a faded `─`.
- Modules sorted by `position` from the group's course; capped at first 6 with "+N" overflow.

No removal of existing columns. Same column shows for teachers viewing their groups (existing page already gates by role).

## 3. Telegram bot — replace "🩺 Guruh holati" with "📚 Vazifalar"

In `getTeacherKeyboard()`, swap `tKbHealth` button for new `tKbHomework` ("📚 Vazifalar"). Old `/thealth` command stays accessible (typed) so we don't break anything; just hidden from the keyboard.

### New `/thomework` handler

For the active group, show a clean list with two columns (module / submitted‑of‑total) and per‑module action buttons:

```
📚 Vazifa topshirilishi — Guruh A (24 talaba)

M1  Asoslar           20/24  (83%)
M2  Promptlar         15/24  (62%)
M3  Tasvir generatsiya  6/24 (25%)
M4  Loyiha             0/24  (—)
```

Followed by **inline keyboards, one row per module**:

```
[ M1 ✅ Topshirganlar ] [ M1 ❌ Topshirmaganlar ]
[ M2 ✅ Topshirganlar ] [ M2 ❌ Topshirmaganlar ]
...
```

Callbacks: `thw:sub:<group>:<module>` and `thw:not:<group>:<module>`.

When tapped:
- `sub` → list of usernames who submitted, with one `homework_submissions` link per submitted assignment in that module:
  ```
  ✅ M2 — Topshirganlar (15/24)
  • @aliya — Promptlar 1, Promptlar 2 (links)
  • @bobur — Promptlar 1
  ...
  ```
- `not` → list of usernames who did NOT submit anything for that module:
  ```
  ❌ M2 — Topshirmaganlar (9/24)
  • @malika
  • @sherzod
  ...
  ```

Long lists are chunked at ~3500 chars (existing `chunks` pattern in the file).

### Effectiveness improvements over the user's draft

1. **One overview message** with all modules + counts so the teacher can spot weak modules at a glance, instead of opening each module separately.
2. **Percentage** shown next to each module so teachers immediately see which module needs attention.
3. **Action buttons grouped per module** (one row each) — teachers tap directly on the weak module without re-typing.
4. **Submitted view links to actual submissions** so the teacher can jump to grading from there (we already have message URLs).
5. The "Guruh statistikasi" `/tstats` summary will get one extra line: `📚 Vazifa topshirgan (jami): X / Y`.

## 4. Files

- New migration: create `admin_group_module_submissions(uuid)` RPC with admin + teacher access.
- `src/pages/admin/AdminGroups.tsx` — fetch new RPC + new column with mini bars.
- `src/pages/admin/GroupDetail.tsx` — add same per-module bar block at top.
- `supabase/functions/telegram-bot-webhook/index.ts`:
  - Add `tKbHomework` label (uz/ru/en), swap into `getTeacherKeyboard`.
  - Map label → `/thomework` command in the keyboard-label resolver.
  - Implement `/thomework` handler + `thw:sub` / `thw:not` callbacks.
  - Add summary line to `/tstats` output.

## Out of scope

- No grading UI changes.
- No change to student-facing flow.
- No change to `admin_group_engagement_stats` (kept as-is).
