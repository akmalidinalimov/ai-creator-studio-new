## Why "@@" appears

The Telegram column in the UI always renders as `@{telegram_username}` (it prepends an `@` for display). So if the value stored in the database is already `@FMuhitdinova`, the screen shows `@@FMuhitdinova`. The stored value should never include the leading `@`.

Two paths today let an `@` slip into the stored value:

1. **`sheet-sync` edge function** — accepts `telegram_username` and forwards it verbatim to `admin-create-students`. The regex `^@?[A-Za-z0-9_]{4,32}$` allows a leading `@` but nothing strips it. Rows imported from the sales Google Sheet (e.g. group "1-GURUH VIP 5.0" in the screenshot) end up stored as `@username`.
2. **Manual "Yangi talaba qo'shish" dialog** (`AddStudentToGroupDialog` in `src/pages/admin/AdminGroups.tsx`) — uses `tgUser.replace(/^@/, "").trim()`. If the pasted value has any leading whitespace (e.g. `" @username"`), the `^@` anchor doesn't match because the first character is a space, and after the later `.trim()` the `@` remains. The same ordering bug exists in a few other spots.

Backend `admin-create-students` then stores `telegram_username` verbatim, so a leaked `@` is persisted.

## Fix (defense in depth + cleanup)

### 1. Single normalization helper (frontend)
Add a small util `normalizeTgUsername(input)` that:
- Coerces to string, trims, removes surrounding quotes,
- Strips **all** leading `@` characters (`/^@+/`),
- Lowercases only when comparing (storage keeps original case),
- Returns `""` for empty.

Use it everywhere we currently call `.replace(/^@/, "")` on telegram_username inputs:
- `src/pages/admin/AdminGroups.tsx` — `AddStudentToGroupDialog` submit, CSV-paste add path (`v.replace(/^@/, "")`), search lookup.
- `src/pages/admin/GroupDetail.tsx` — `handleAddByLookup` and CSV import row parsing.
- `src/pages/SalesIntake.tsx` — username field before submit.

### 2. Backend hardening — `supabase/functions/admin-create-students/index.ts`
Before writing `profilePatch.telegram_username`, strip leading `@`s and trim:
```ts
const cleanTgUsername = (s.telegram_username || "").trim().replace(/^@+/, "");
```
Use `cleanTgUsername` in the two places that currently assign the raw value (around lines 416 and 444), and in the patch-update comparison (line 368 already lowercases without `@`, so no change needed there). This guarantees nothing with a leading `@` is ever written, regardless of caller.

### 3. Backend hardening — `supabase/functions/sheet-sync/index.ts`
After `const username = norm(r.telegram_username);`, strip the leading `@` before validation/forwarding so the Google Sheet can include or omit `@` without corrupting data.

### 4. One-time data cleanup migration
Existing rows already have `@username`. Run a migration to fix them:
```sql
UPDATE public.profiles
SET telegram_username = regexp_replace(telegram_username, '^@+', '')
WHERE telegram_username LIKE '@%';
```
This is safe: uniqueness on `telegram_username` would only break if two rows had the same handle stored once with `@` and once without — we can check first with a SELECT and only then commit. If a collision exists we'll merge/skip as needed (rare; will surface in the read query result before the UPDATE runs).

### 5. Redeploy
After the code changes, redeploy `admin-create-students` and `sheet-sync`.

## Out of scope
- The display logic (`@${u.telegram_username}`) stays as-is — that's the correct rendering once stored values are clean.
- No DB schema changes, no auth changes, no other edge functions touched.

## Files changed
- `src/lib/format.ts` (or a new `src/lib/telegram.ts`) — add `normalizeTgUsername` helper.
- `src/pages/admin/AdminGroups.tsx`
- `src/pages/admin/GroupDetail.tsx`
- `src/pages/SalesIntake.tsx`
- `supabase/functions/admin-create-students/index.ts`
- `supabase/functions/sheet-sync/index.ts`
- New migration: cleanup UPDATE on `public.profiles.telegram_username`.