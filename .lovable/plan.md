# Fix CSV group import errors

## What's happening

When uploading the group CSV, 10 rows fail with:

> `tg-угилой@telegram.local: Unable to validate email address: invalid format`
> `tg-н.@telegram.local: …`
> `tg-мухайё☀@telegram.local: …`
> `tg-q^@telegram.local: …`

Supabase Auth's email validator only accepts **ASCII** local parts. When a row has no real email, our edge function (`admin-create-students`) synthesizes a placeholder like `tg-<something>@telegram.local`. For Cyrillic names (`Угилой`, `Мохичехра`, `Бегзод`), emoji (`☀`, `🌸`), dots, carets, or spaces, that synthesized email is rejected and the row fails.

The 39 "Allaqachon" (already exists) users were imported during an earlier attempt where some bad placeholders did slip through; the 10 "Xato" rows are the ones the validator now rejects.

## Root cause

In `supabase/functions/admin-create-students/index.ts` (lines 159–177):

- It tries to use `tg-<telegram_user_id>@telegram.local` first (good).
- But when `telegram_user_id` is missing/unparsable, it falls back to the raw `telegram_username` or, in older imports, the `name` — neither is sanitized for ASCII / valid-email characters.

Some CSV rows have non-numeric or quoted IDs, or a `name` containing Cyrillic/emoji, so the placeholder becomes invalid.

## Fix

### 1. Edge function — always produce an Auth-safe placeholder

In `supabase/functions/admin-create-students/index.ts`:

- Make `telegram_user_id` parsing more tolerant: strip whitespace, quotes, and non-digit chars before `Number(...)`.
- When the ID is present, **always** use `tg-<id>@telegram.local` (already correct, just hardened).
- When falling back to the username, **sanitize** it: lowercase, strip `@`, then keep only `[a-z0-9._-]` and trim to ≤32 chars. Drop empty results.
- If after sanitization there is still nothing usable, mint a deterministic safe placeholder using a short hash of `name + row index`, e.g. `tg-anon-<6charhash>@telegram.local`, so Auth always accepts it and the row can still be created and later linked via Telegram bot.
- Add the same sanitizer to the existing-profile dedupe lookup so we don't create duplicates.

### 2. Edge function — better error reporting

When `auth.admin.createUser` fails on email validation, surface a clearer message in the response (`invalid_placeholder_email` instead of the raw Supabase string) so the UI's error pill is readable.

### 3. CSV preview (`src/pages/admin/GroupDetail.tsx`)

Already validates "need email/tg id/username", but it doesn't warn when the synthesized placeholder will be non-ASCII. Add a soft pre-check: if no email and no numeric `telegram_user_id`, and the username contains non-ASCII characters, mark the row's status hint as "placeholder will be auto-generated" so the admin sees what's coming.

### 4. Clean up the 10 broken rows

These rows did NOT create auth users (that's why they show as Xato), so nothing to delete. Re-uploading the same CSV after the fix will pick them up and create them with safe placeholders. No data migration needed.

### Optional — also harden the second importer

`src/pages/admin/AdminGroups.tsx` has a simpler one-column importer (`handleCsv`) that does its own synthesis client-side. It already routes numeric values to `telegram_user_id` and `@`-strings to email, so it's fine, but I'll add the same sanitizer to the username path for consistency.

## Files to change

- `supabase/functions/admin-create-students/index.ts` — tolerant ID parsing, ASCII sanitizer, deterministic anon fallback, clearer error labels.
- `src/pages/admin/GroupDetail.tsx` — preview hint when a placeholder will be synthesized.
- `src/pages/admin/AdminGroups.tsx` — apply the same username sanitizer (small).

## Verification

1. Re-upload `users_import_1guruh.csv` in the **Students in 1-GURUH** dialog.
2. Expect: **0 Xato**, ~10 new users created with safe placeholder emails (e.g. `tg-7882146989@telegram.local`).
3. Open one of the new students and confirm `telegram_id`, `telegram_username`, `group_id`, and display name (`Угилой`, `Бегзод`, etc.) are stored correctly — only the email placeholder is sanitized.
4. The Telegram bot login still works because it matches by `telegram_id` / `telegram_username`, not by email.
