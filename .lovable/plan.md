# v3.0.2 — Role UI + Teacher Bot + Per-group CSV + Group Detail

Additive release. Student dashboard, video player, watch tracking, student bot keyboard, and admin v2.x flows are not modified.

## A. Database migration

New SQL migration adds:

1. `superadmin` value to `app_role` enum.
2. `audit_log` table:
   - `id uuid pk`, `actor_user_id uuid`, `target_user_id uuid`, `action text`, `old_value jsonb`, `new_value jsonb`, `created_at timestamptz`
   - RLS: admin/superadmin SELECT only; INSERT only via security-definer function.
3. `groups.is_default boolean default false` + partial unique index ensuring at most one default group.
4. `profiles.group_id` already exists (v3.0).
5. New security-definer functions (callable by service role + admin/teacher as appropriate):
   - `admin_change_role(target uuid, new_role app_role)` — enforces:
     - actor must be admin or superadmin
     - only superadmin may grant/revoke `admin` or `superadmin`
     - actor cannot change own role
     - writes audit_log row
   - `staff_group_overview(group_id uuid)` → totals, active_7d, completion %, avg score, health score (admins: any group; teachers: only their groups).
   - `staff_group_members(group_id uuid)` → per-member rows for detail page (scoped same way).
   - `staff_group_module_completion(group_id uuid)` → per-module completion %.
   - `staff_group_recent_activity(group_id uuid, lim int)` → recent lessons/auth events for the group.
   - `staff_top_students(uid uuid, lim int)` → top-N for teacher's groups.
   - `admin_assign_group(user_ids uuid[], group_id uuid)` — bulk reassign; admin only; logs to audit_log.
   - `group_health_score(group_id uuid)` — pure function used by overview & list.
6. View / RPC `admin_ungrouped_students()` returning students with `group_id IS NULL` and no `admin` role.

Health formula: `0.4*active_7d_pct + 0.4*avg_completion_pct + 0.2*avg_score_pct`, rounded to int.

## B. Role management UI (`/admin/users`)

Edit `src/pages/admin/AdminUsers.tsx`:

- Add a `Role` column (Student / Teacher / Admin / Superadmin) using a `Select` per row.
- Disabled when `row.id === currentUser.id` (self) or when current user lacks privilege for the target role.
- On change → AlertDialog "Are you sure you want to change {{name}} to {{role}}?" → calls new edge function `admin-change-role` (which calls the SQL function above).
- Bulk reassign: checkbox column + sticky action bar with "Move N to group ▾" (admin only). Calls `admin_assign_group`.
- All mutations refresh the list and toast results.

## C. Bot teacher keyboard

Edit `supabase/functions/telegram-bot-webhook/index.ts`:

- Detect `role === 'teacher'` for the matched profile (already loaded in handlers).
- New `getTeacherKeyboard(locale)` with the 6 buttons (uz/ru/en variants):
  - 📊 Guruh statistikasi
  - 👥 Mening talabalarim
  - ⚠️ Faol bo'lmaganlar
  - 🏆 TOP talabalar
  - 💬 Guruhga xabar
  - ⚙️ Sozlamalar / ❓ Yordam
- Replace the two `isAdmin ? adminKb : mainKb` sites with a 3-way: admin → admin kb, teacher → teacher kb, else student kb.
- Add a locale-tolerant text router: a normalized lookup table of teacher button strings (all 3 locales) → handler.
- Handlers (each scoped via the v3.0.1 + new RPCs):
  - **Stats**: call `staff_group_overview` for each group teacher owns; reply with totals + inline buttons `[📥 CSV · 📈 Modullar · 🏥 Sog'lik]`.
  - **My students**: list from `staff_list_students`, status emoji from `last_sign_in_at` (🟢 ≤3d, 🟡 ≤7d, 🔴 older / never).
  - **Inactive**: filter by ≥3d; `[📥 CSV · ⏰ 7+ kun]` toggles threshold.
  - **Top students**: `staff_top_students(uid, 10)`.
  - **Broadcast (Guruhga xabar)**: stateful flow using a small `bot_states` row (or reuse existing state mechanism in the file) — prompt → preview with inline `[✅ Ha · ❌ Yo'q]` → on confirm, iterate group members and send via Telegram API. Rate-limit table `bot_broadcast_rate` keyed by `teacher_id` (1/h) and `student_id` (1/min) — both upserted on send.
  - **Settings**: route to existing `/sozlamalar` flow.
  - **Help**: existing help text.
- Student keyboard and admin keyboard are not modified.

## D. Per-group CSV import

1. Edit `supabase/functions/admin-create-students/index.ts`:
   - Accept new optional body field `target_group_id: uuid`.
   - When set: ignore CSV's `group_name` column; for each row do dedup by (email | telegram_user_id | lower(telegram_username)). 
     - If matched profile exists → `UPDATE profiles SET group_id=target` only (no auth user creation), result status `moved`.
     - If matched profile already has `group_id = target` → status `already_in_group`.
     - Else → existing create flow + `group_id=target`, status `created`.
   - Return summary `{ created, moved, already_in_group, duplicates_in_file, invalid }`.

2. UI: dialog on Group Detail page mirrors `AdminUsers` CSV dialog but without group_name column; shows the summary line and only counts `created+moved` in the action button.

## E. Group detail page

New file `src/pages/admin/GroupDetail.tsx`, route `/admin/groups/:id` (added to `App.tsx`, with `staffOnly` guard — RPCs already scope teacher access).

Sections:
1. **Header card**: editable name, teacher (Combobox of users with role teacher/admin), course (Select), created date.
2. **Stat tiles**: total / active 7d / completion % / avg score / health score badge.
3. **Members table**: name, @username (link `https://t.me/<username>`), telegram_user_id, last activity, status emoji, score, Remove button (sets `group_id = null`).
4. **Add students**: `[➕ Add by username/ID]` (small inline form using existing profile lookup) and `[📥 Upload CSV to group]` (dialog from D).
5. **Per-module completion**: bar chart from `staff_group_module_completion` (recharts, already in project).
6. **Recent activity**: list from `staff_group_recent_activity`.

`AdminGroups.tsx` updated so each row links to the detail page and shows the colored health badge + a star toggle for "default group" (admin only).

## F. Dashboard improvements

Edit `src/pages/admin/AdminDashboard.tsx`:

- Add **Ungrouped** tile (admin only, hidden when count = 0 OR shown with green ✓ — choosing: hidden when 0).
- Click → drawer/modal listing ungrouped students with checkboxes and a "Move to group ▾" action calling `admin_assign_group`.

## G. i18n

Add new keys under `admin.users.role`, `admin.groups.detail.*`, `admin.dashboard.ungrouped`, `bot.teacher.*` to `uz.json`, `ru.json`, `en.json`. (No Spanish.)

## Files to create / edit

Create:
- `supabase/migrations/<ts>_v302_role_groups_audit.sql`
- `supabase/functions/admin-change-role/index.ts`
- `src/pages/admin/GroupDetail.tsx`
- `mem://features/v3-groups-roles` summarizing role rules + health formula

Edit:
- `src/App.tsx` (route)
- `src/pages/admin/AdminUsers.tsx` (role column, bulk reassign, modals)
- `src/pages/admin/AdminGroups.tsx` (link to detail, health badge, default-star)
- `src/pages/admin/AdminDashboard.tsx` (ungrouped tile + drill-down)
- `supabase/functions/admin-create-students/index.ts` (target_group_id + dedup)
- `supabase/functions/telegram-bot-webhook/index.ts` (teacher keyboard + handlers + broadcast)
- `src/i18n/locales/{uz,ru,en}.json`
- `src/integrations/supabase/types.ts` (auto-regen after migration)

## Verification (after build)

Run through the 12-step checklist in the request. Specifically I'll:
1. Curl `admin-change-role` to confirm self-change blocked + audit row written.
2. Trigger bot webhook for a teacher chat_id and assert teacher keyboard returned.
3. Upload a CSV to a group twice and confirm idempotent counts.
4. Query `audit_log` and `groups.is_default` post-migration.

## Out of scope (unchanged)

Student dashboard, video player, watch tracking, student bot keyboard, global `/admin/users` CSV behavior, v2.x cron jobs, RLS policies on existing tables.
