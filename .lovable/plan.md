## Problem

In `/admin/users` and `/admin/groups`, searching by Telegram username doesn't work when the user types it with the `@` prefix (e.g. `@shahlo`). The filter compares the raw query against stored usernames which have no `@`, so it never matches. Searching by first name works because names don't contain `@`.

## Fix

Strip a leading `@` from the search query before comparing in both filter blocks. Frontend-only change.

### Files

**`src/pages/admin/AdminUsers.tsx`** — `filtered` useMemo (~line 271)
```ts
const q = search.trim().toLowerCase().replace(/^@/, "");
```

**`src/pages/admin/AdminGroups.tsx`** — `filtered` useMemo (~line 684)
```ts
const s = search.trim().toLowerCase().replace(/^@/, "");
```

Both filters already include `telegram_username` in the matched fields, so stripping `@` is sufficient — no other logic changes needed.