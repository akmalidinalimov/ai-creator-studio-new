## Add Bulk Delete to /admin/users

The page already supports per-user delete (calls `admin-create-students` edge function with DELETE method) and bulk-selection (checkboxes feed `selected: Set<string>`). It only lacks a bulk delete action button — currently only Move-to-group, Archive, Unarchive, and Resend Welcome appear when rows are selected.

### Changes (single file: `src/pages/admin/AdminUsers.tsx`)

1. **New state** `confirmBulkDelete: string[] | null` for confirm dialog.

2. **New handler** `bulkDelete(ids)`:
   - Loops `ids` and calls existing `admin-create-students` edge function with `DELETE` method + `{ userId }` (same as `removeUser`) sequentially with `Promise.allSettled` for parallelism.
   - Tracks success/failure counts; toasts `"{n}/{total} foydalanuvchi o'chirildi"`.
   - Logs `bulk_delete_users` admin action with the id list.
   - Clears `selected`, closes dialog, calls `reload()`.

3. **Toolbar button** (in the bulk action row near line 769–778, visible to admins when `selected.size > 0`, regardless of `statusFilter`):
   ```tsx
   <Button variant="destructive" size="sm"
     onClick={() => setConfirmBulkDelete(Array.from(selected))}>
     <Trash2 className="h-4 w-4" /> O'chirish ({selected.size})
   </Button>
   ```

4. **Confirm AlertDialog** mirroring the existing single-user `confirmDelete` dialog, with strong wording:
   - Title: "{n} ta foydalanuvchini o'chirish?"
   - Description: "Bu amalni qaytarib bo'lmaydi. Barcha tegishli ma'lumotlar (progress, baholar, sertifikatlar) o'chiriladi. Arxivlash xavfsizroq variant."
   - Cancel + destructive Confirm → `bulkDelete(confirmBulkDelete)`.

5. **i18n**: add `admin.users.bulkDelete`, `admin.users.bulkDeleteConfirmTitle`, `admin.users.bulkDeleteConfirmDesc`, `admin.users.toasts.bulkDeleted` keys for uz/ru/en.

### Out of scope
- No edge function changes (existing `admin-create-students` DELETE works per-user).
- No schema migration.
- Self-deletion guard (admin deleting themselves) is already handled by the edge function; we'll surface its error in the toast.

### Verify
- Select multiple rows → red "O'chirish (N)" appears next to Archive button.
- Click → confirm dialog → users removed, list refreshes, toast shows count.
- Works in both Active and Archived filter views.
