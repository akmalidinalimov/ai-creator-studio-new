# Admin "Log in as Teacher/Student" (Impersonation)

Date: 2026-06-09
Status: Approved (design) — pending implementation

## Goal
Let an admin reproduce exactly what a teacher (or student) sees, on both surfaces:
- **Web platform:** become that user in a real session.
- **Telegram bot:** act as that teacher inside the admin's own Telegram.

Entry by Telegram `@username`, Telegram ID, or internal user id.

## Decisions (locked)
- Web mechanism: **full session**, reusing the existing magic-link flow. Opened in an **incognito/separate window** so the admin's own session is untouched.
- Surfaces: **both** (web + Telegram bot).
- Who can impersonate: **admin + superadmin**.
- Who can be impersonated: **teacher or student**, never admin/superadmin (privilege-escalation guard). Never self.
- Every impersonation start is **audit-logged**.

## A. Web — `admin-impersonate` edge function
New function `supabase/functions/admin-impersonate/index.ts`:
1. Read caller JWT (`Authorization`); verify `has_role(admin)` OR `has_role(superadmin)` via a user-scoped client. Else 403.
2. Body: `{ telegram_username?, telegram_id?, user_id? }`. Resolve to exactly one target profile (strip leading `@`; match `telegram_username` case-insensitively, or `telegram_id::text`, or `id`). If 0 or >1 matches → 404/409 with a clear message.
3. Guard: target must NOT have `admin`/`superadmin` role; target ≠ caller. Else 403.
4. Look up the target's auth email (`auth.admin.getUserById`).
5. Insert a row into existing `telegram_magic_links` (`user_id`=target, `token`=random, `expires_at`=now()+5min, `target_path`=`/dashboard`, `used_at`=null).
6. Insert `audit_log` (actor=caller, target, action=`impersonate_start`, metadata: surface=web).
7. Return `{ url: "<SITE_URL>/auth/magic?token=<token>&imp=1&as=<url-encoded name>" }`. The `imp=1` marker distinguishes impersonation from a normal teacher self-login through the same page.

No new redeem logic: the existing `/auth/magic` page + `magic-link-redeem` mint the session. (We reuse `telegram_magic_links` and its single-use + expiry semantics as-is.)

`supabase/config.toml`: `admin-impersonate` `verify_jwt = true` (must carry the admin's JWT).

## B. Web — admin panel UI
- In `AdminUsers` (and the teacher list in `AdminGroups`): a row action **"Log in as"** → calls `admin-impersonate` with that user's id → opens `url` in a **new tab** (`window.open(url, "_blank")`), with a tooltip reminding to use incognito to preserve the admin session.
- A small input on `AdminUsers`: paste `@username` or Telegram ID → same call → open tab.
- **Impersonation banner:** when `/auth/magic` sees `imp=1`, it sets `sessionStorage.impersonating = "<as name>"` after a successful redeem (normal self-logins have no `imp` param, so no banner). A global banner component reads it and renders a fixed red bar: "👁 Viewing as <name> — Exit". Exit = `supabase.auth.signOut()` + clear the flag. (Honest limitation: banner is client-side; the underlying session is a real user session.)

## C. Telegram bot — `/asteacher`
In `telegram-bot-webhook`:
- New admin command `/asteacher <@username|telegram_id>`:
  - Verify caller persona is admin. Resolve target (must have `teacher` or `student` role; never admin).
  - Store impersonation in `bot_sessions` for the admin: `state="impersonate"`, `data={ as_user_id, as_persona }`.
  - Reply with the impersonated persona's keyboard + notice: "👁 Acting as <name>. /admin to exit."
  - Write `audit_log` (action=`impersonate_start`, surface=telegram).
- Command routing: when the admin has an active `impersonate` session, teacher/student commands resolve their target id from `as_user_id` instead of the admin's own id (e.g., `teacherGroups(admin, as_user_id)`).
- `/admin` (existing) clears the impersonate session → back to admin keyboard.

## Security & audit
- Admin/superadmin only (both surfaces).
- Cannot impersonate admin/superadmin; cannot impersonate self.
- `audit_log` row on every start (actor, target, surface, timestamp).
- Web session expiry inherits normal Supabase session; magic token is single-use + 5-min expiry.

## Data flow (web)
Admin clicks "Log in as" → `admin-impersonate` (JWT) → validates + creates magic token + audit → returns `/auth/magic?token=…` → admin opens in incognito → `/auth/magic` → `magic-link-redeem` → `setSession` → teacher dashboard, banner shows.

## Deploy split
- `admin-impersonate` edge fn + `config.toml` + `/asteacher` bot changes → via Lovable.
- Admin-panel button/input + banner component → repo (Lovable/Vercel).

## Test plan
- Web: as admin, "Log in as" a known teacher → incognito tab lands on their dashboard; teacher pages render their data; banner + Exit work. Repeat for a student.
- Guard: attempt to impersonate an admin → blocked. Non-admin calling the function → 403. Unknown username → clear error.
- Telegram: `/asteacher @teacher` → teacher keyboard + their groups/stats; `/admin` exits. `/asteacher` as non-admin → ignored.
- Audit: each start appears in `audit_log`.

## Out of scope (YAGNI)
- Time-boxed auto-expiry of an active web impersonation session (relies on normal logout/incognito-close).
- Impersonating admins/superadmins.
- A full server-enforced "read-only" mode (we chose full session).
