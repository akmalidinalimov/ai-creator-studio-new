## v3.14.35 — Prevent duplicate group members and dual teacher/student roles

### Goal
- A person (matched by Telegram ID, Telegram username, or email) can never appear twice in the same group.
- Teacher and student roles are **mutually exclusive globally**: an existing teacher cannot be added as a student anywhere, and an existing student cannot be promoted to teacher without an explicit role change. Adding violates this is rejected with a clear message.

### Where the bug lives today
1. `supabase/functions/admin-create-students/index.ts`
   - When matching an existing profile, it updates `profiles.group_id` even if the user already holds a `teacher` role (only checks `s.role` of incoming row, not current DB roles). Result: an existing teacher gets re-bucketed as a student in a group.
   - For `s.role === "teacher"`, it `upsert`s the teacher role and overrides `groups.teacher_id` without checking if the user is already a student.
   - No "already in this group" rejection — silently returns `skipped_already_in_group`, which is fine for CSV but used by single-add too.
2. `src/pages/admin/GroupDetail.tsx` `handleAddByLookup` (lines 143–177)
   - Bypasses the edge function entirely and just does `update profiles.group_id` — no role check, no duplicate check, no teacher protection. This is the path the user used to add the same person twice.
3. `src/pages/admin/AdminUsers.tsx` "create user" path lets admin pick role `teacher | student | admin` for an email that may already exist in the other role — same root cause.

### Fix plan

**A. Single source of truth in the edge function `admin-create-students`**

Add a pre-flight check executed for every incoming row (single-add and CSV):

1. Resolve existing profile by priority `telegram_id → telegram_username → email`.
2. If found, fetch its current roles from `user_roles`.
3. Apply rules:
   - Incoming `role=student` and existing has `teacher` role → return `status:"role_conflict"`, `error:"Bu foydalanuvchi tizimda o'qituvchi sifatida ro'yxatdan o'tgan. Talaba qilib qo'shib bo'lmaydi."`
   - Incoming `role=teacher` and existing has `student` role (or non-null `group_id` as a student) → return `status:"role_conflict"`, `error:"Bu foydalanuvchi tizimda talaba sifatida mavjud. O'qituvchi qilib qo'shib bo'lmaydi."`
   - Incoming `role=student` and existing already has `group_id === resolvedGroupId` → return `status:"already_in_group"`, `error:"Bu foydalanuvchi allaqachon shu guruhda."` (today this returns benign "skipped"; we keep the row but flip status so the UI can show a warning toast on single-add and a yellow row on CSV).
   - Incoming `role=teacher` and existing is already `groups.teacher_id` of the target group → `status:"already_teacher_of_group"`.
4. Only when no conflict: proceed with current update/teacher-assignment/insert logic.

Also: when creating a brand-new user with `role=teacher`, the function already sets `groups.teacher_id`. We additionally guard against making a `teacher` who is already in a `groups.profiles.group_id` somewhere as a student.

**B. Replace the unsafe direct path in `GroupDetail.tsx`**

`handleAddByLookup` (the "Username yoki ID bilan qo'shish" dialog) currently writes `profiles.group_id` directly. Change it to call `admin-create-students` with a single row `{ telegram_user_id | telegram_username, role:"student", target_group_id: id }`, then surface the conflict/already-in-group/error messages from the response with a clear toast.

**C. AdminUsers create-user flow**

In `AdminUsers.tsx` (single-create dialog), when admin selects `role=teacher` for an email that resolves to an existing student profile (or vice versa), rely on the edge function rejection and show the returned `error`. No client-side bypass.

**D. Database guard (defense in depth)**

Add a database trigger `enforce_role_exclusivity` on `public.user_roles`:
- Before insert/update, if `NEW.role = 'student'` and EXISTS `user_roles where user_id=NEW.user_id and role='teacher'`, raise.
- Symmetric for `teacher` vs `student`.
- Admin role unaffected.

This protects against any future code path or manual SQL.

We do **not** add a unique-on-(group_id,user_id) constraint because group membership is just `profiles.group_id` (one row per profile), so duplicates within the same group are already structurally impossible at the DB layer; the duplicate symptom comes purely from re-assigning the same user with a different role bucket. The role-exclusivity trigger plus the edge-function pre-flight cover it.

### UX changes
- Single-add toast: success | "Bu foydalanuvchi allaqachon shu guruhda" | "Foydalanuvchi tizimda boshqa rolda mavjud (o'qituvchi/talaba)".
- CSV import counts: add a new `role_conflict` bucket alongside `error` and `skipped_already_in_group`, surfaced in the existing "Tafsilotlar" toast list.

### Files to change
- `supabase/functions/admin-create-students/index.ts` — pre-flight role/group-duplicate check, new result statuses.
- `src/pages/admin/GroupDetail.tsx` — `handleAddByLookup` rewritten to call the edge function; toast shows conflict reasons. CSV result handler updated to display `role_conflict` rows.
- `src/pages/admin/AdminUsers.tsx` — surface returned conflict error in the single-create dialog (no behavior change otherwise).
- New migration: `enforce_role_exclusivity` trigger on `public.user_roles`.

### Out of scope (not touched)
Telegram bot webhook, Statistika, homework flow, identity gate, RPC auth pattern, dashboard, magic links, lesson/course pages, design system. Frozen v3.14.10–v3.14.34.

### Verification
1. Add user X as teacher to Group A → success.
2. Try to add the same X as student to Group B → rejected with "boshqa rolda mavjud" toast.
3. Try to add X as student to Group A again via username → rejected with "allaqachon shu guruhda".
4. CSV import containing a row whose Telegram ID already belongs to a teacher → row reported as `role_conflict` in details toast, not silently moved.
5. Direct SQL `INSERT INTO user_roles (user_id, role) VALUES ('<existing-teacher>', 'student')` → trigger raises.