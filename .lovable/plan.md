# Show Group on Users + Filter + Export by Group

## What you'll see after this change

On **Admin → Users**:

1. A new **Group** column on the users table (and on the mobile cards) showing each student's assigned group name (e.g. "Group A"). Empty groups show "—".
2. A new **Group** filter dropdown next to the existing Status / Role filters: *All groups*, plus one entry per group, plus *No group*.
3. A new **Export CSV** button in the toolbar. It exports the **currently filtered list** of users — so to export a single group, you pick that group in the filter and click Export. The CSV uses the same column layout as the import template, so it round-trips cleanly.
4. The downloadable **CSV import template** already includes a `group_name` column today (and the importer already creates/assigns the group). No change needed there beyond making sure the filename and helper text mention it clearly.

The bulk **"Move N to group…"** action that's already on the page stays as-is.

## Already in place (no work needed)

- `profiles.group_id` column exists and is populated.
- CSV importer (`admin-create-students` edge function) already reads `group_name`, auto-creates the group if missing, and assigns the student to it.
- The current CSV template (`CSV_TEMPLATE` in `AdminUsers.tsx`) already has a `group_name` column with examples.
- `groups` are already loaded into the page state (`groups`, used by the bulk-move dropdown).
- Each user row already carries `group_id` (hydrated from profiles in `reload()`).

## Technical changes

All edits are in **`src/pages/admin/AdminUsers.tsx`** — no DB migration, no edge-function change.

1. **Group lookup map**: derive `groupNameById` from the existing `groups` state (`Map<string, string>`).

2. **Filter state**: add `const [groupFilter, setGroupFilter] = useState<string>("all")` where value is `"all"`, `"none"`, or a group id. Extend the `filtered` `useMemo` to apply it.

3. **Filter UI**: add a `<Select>` next to Status/Role filters, populated from `groups` plus an "All groups" and "No group" entry.

4. **Group column** in the desktop `<table>`: insert `<th>Group</th>` after Role (or before Status) and a `<td>` rendering `groupNameById.get(u.group_id) ?? "—"`. Update the `colSpan={10}` placeholders to `11`.

5. **Group line on mobile cards**: add a small line showing the group name when present.

6. **Export CSV button**: new toolbar button next to "Import CSV". Implementation:
   - Builds rows from `filtered` (so the group filter scopes the export).
   - Columns match the import template exactly: `name,last_name,email,password,telegram_user_id,telegram_username,role,group_name`.
   - `password` is left blank (we don't expose stored passwords).
   - Uses Papa.unparse for proper escaping.
   - Filename: `users_<groupName-or-all>_<YYYY-MM-DD>.csv`.

7. **Localization**: add `admin.users.headers.group`, `admin.users.allGroups`, `admin.users.noGroup`, `admin.users.exportCsv` keys to `src/i18n/locales/{uz,ru,en}.json` with sensible defaults.

## Out of scope

- The CSV template content already has `group_name` — no template change needed.
- No DB schema changes.
- Teacher view (`staff_list_students`) already returns the same shape; the Group column will work for them too if they have access (read-only filter).
