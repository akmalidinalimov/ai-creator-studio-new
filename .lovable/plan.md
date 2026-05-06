## Problem analysis

There are two distinct bugs, both rooted in the same area (SAP support added on top of legacy single-task homeworks).

### 1. "duplicate key value violates unique constraint `homework_assignments_module_task_uniq`"

The original migration (`20260503182607_…`) created the legacy uniqueness rule as a **unique INDEX**, not a constraint:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_module_task_uniq
  ON public.homework_assignments(module_id, task_number);
```

The recent SAP migration (`20260506125414_…`) tried to remove it with:

```sql
ALTER TABLE … DROP CONSTRAINT IF EXISTS homework_assignments_module_task_uniq;
```

`DROP CONSTRAINT` does nothing for a plain index, so the old `(module_id, task_number)` unique index is **still enforced**. When admin adds a SAP under V1 of M3, the SAP row reuses `module_id` + `task_number = 1` (the parent's number) → collision with the parent row → the error you saw.

### 2. Telegram bot shows SAPs as separate top-level buttons next to M1, M2…

In `telegram-bot-webhook/index.ts` `buildHomeworkMessage()`, the menu pushes **one inline button per leaf**:

```ts
buttons.push([{ text: t.hwSubmitBtn(m.position + 1, tnLabel), callback_data: `hw:start:${a.id}` }]);
```

So a module with 3 SAPs produces 3 separate buttons (`M3.1`, `M3.2`, `M3.3`) all rendered flat in the same inline keyboard, with no visual hierarchy → looks like siblings of M1/M2 buttons.

We want: **one button per module** (e.g. "M3 — module title"). Tapping it expands a second-level inline keyboard listing each SAP submit button for that module.

---

## Plan

### A. Database fix (1 migration)

Drop the lingering legacy unique index and re-confirm the partial indexes already added by the SAP migration.

```sql
-- Remove the legacy index that still enforces (module_id, task_number) uniqueness.
DROP INDEX IF EXISTS public.homework_assignments_module_task_uniq;

-- Sanity-recreate the partial indexes (idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_module_task_parent_uniq
  ON public.homework_assignments(module_id, task_number)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_parent_sap_uniq
  ON public.homework_assignments(parent_id, sap_number)
  WHERE parent_id IS NOT NULL;
```

After this, adding SAPs (which share `task_number` with their parent) works because the parent-only partial index excludes SAP rows.

### B. Telegram bot menu — collapse into one button per module

Edit `supabase/functions/telegram-bot-webhook/index.ts`:

1. **`buildHomeworkMessage()`** (~line 1085–1169):
   - Stop emitting one `hw:start:<assignmentId>` button per leaf.
   - For each module that has at least one ungraded leaf and a configured group topic, emit **a single button**:
     ```ts
     { text: `📝 M${m.position+1} — ${m.title}`, callback_data: `hw:mod:${m.mid}` }
     ```
   - Keep the textual status block (V1/V1.S1 scored/unscored lines) as it is.

2. **New callback handler `hw:mod:<moduleId>`** (alongside existing `hw:start:` handler ~line 3167):
   - Look up active assignments for that module + the user's submissions.
   - Compute the SAP/parent leaves the same way as the picker.
   - Render a new inline keyboard with one `hw:start:<assignmentId>` button per **ungraded** leaf, labeled `V{n}` or `V{n}.S{m}` plus the title (truncated).
   - Use `editMessageText` (or send a new message) with the sub-menu and a "⬅️ Orqaga" button (`callback_data: hw:back`) that re-renders the top-level homework menu.

3. **`hw:back` handler**: re-invoke `buildHomeworkMessage(...)` and edit the message back to the module-list view.

4. Keep the existing `hw:start:<id>` flow untouched — it's reused by the new sub-menu.

### C. No changes needed for

- Auto-routing of group-topic submissions (already picks the next un-graded leaf per student — verified earlier).
- Admin UI flow (after the index is dropped, the existing "+SAP" button works).
- Student web UI (`HomeworkSection.tsx`) — already groups SAPs under their parent visually.
- Scoring view — already aggregates leaves correctly.

---

## Files to touch

- `supabase/migrations/<new>.sql` — drop legacy index.
- `supabase/functions/telegram-bot-webhook/index.ts`
  - `buildHomeworkMessage()` — emit one button per module.
  - Callback handler section — add `hw:mod:<moduleId>` and `hw:back` branches; reuse leaf-rendering logic.

## Validation

1. After migration: in Admin Homework, add a SAP under M3 V1 — should succeed (no duplicate-key error).
2. In Telegram bot menu: should show exactly one button per module (M1, M2, M3…). Tapping M3 should reveal V1.S1 / V1.S2 / V1.S3 submit buttons plus a Back button.
3. Student submitting in the M3 group topic still routes to the next un-graded SAP (regression check).
