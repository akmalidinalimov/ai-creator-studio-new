## Fix "Loggedin" and replace "Health" with "Active 3d %"

### Problems found

1. **Loggedin shows 0/0 for every group.** There are TWO `admin_group_login_stats` functions in the database (a zero-arg one and a one-arg one), so `supabase.rpc(...)` fails with "function is not unique" and the UI silently falls back to `{logged: 0, total: 0}`. Also, the existing query joins `auth.users.last_sign_in_at`, which is fragile under RLS.
2. **Health** is an opaque weighted score (40% active% + 40% completion% + 20% avg quiz score). Users don't know what it means.

### What we'll build

**A) New SQL function `admin_group_engagement_stats()`** (replaces both broken ones). Returns one row per group with three counts derived from data we already have:

```text
group_id        | uuid
total_active    | int   -- non-archived students in the group
logged_in_count | int   -- distinct profiles with ≥1 'sign_in' row in auth_events
active_3d_count | int   -- distinct profiles with lesson_progress.updated_at ≥ now() - 3 days
```

Permissions: SECURITY DEFINER, granted to `authenticated`, gated by `has_role(admin|teacher)` like the current RPC. Drops the two old conflicting `admin_group_login_stats` definitions to clean up.

**B) Update `/admin/groups` table:**

- "Loggedin" column → keep label, now shows the real `logged_in_count / total_active` (e.g. `42/57`). Color-coding stays (red 0, amber <50%, green ≥50%).
- "Health" column → renamed to **"Faol (3 kun)"** (UZ) / shows `active_3d_count / total_active` and a percentage badge. Color: red 0%, amber <30%, green ≥30%. Tooltip explains "So'nggi 3 kunda darsda faol bo'lganlar".

**C) Update `GroupDetail.tsx`** to use the same RPC for its `health` field (so the detail header matches the list).

### Files touched

- `supabase/migrations/<timestamp>_group_engagement_stats.sql` — new RPC + drop conflicting old ones.
- `src/pages/admin/AdminGroups.tsx` — call the new RPC, replace Health column UI.
- `src/pages/admin/GroupDetail.tsx` — show "Active 3d" instead of opaque health score.

### How to verify

1. Open `/admin/groups` — Loggedin column should now show non-zero `x/y` for groups whose students have logged in at least once.
2. The renamed column shows what % of each group has opened a lesson in the last 3 days.
3. Open one group's detail page — same active-3d figure appears in the header.
