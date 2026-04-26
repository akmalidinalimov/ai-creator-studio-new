# v1.4 build plan — pragmatic scope

The original spec contains 12 sections; building all 12 well in one pass isn't realistic — several (passkeys, TOTP-required-for-admins, single-session admin enforcement, Turnstile, trusted-device cookies, suspicious-login geo email alerts) are individually multi-day systems that need real-device testing or external secrets you haven't provided. I'm shipping a **tight, well-tested core** now and flagging the rest as a v1.5 follow-up. You can approve and I'll build, or tell me to expand scope.

## ✅ Shipping in this pass

### A. Last name + CSV template + magic-link invites

**Schema** (one migration):
- `profiles.last_name text` nullable.
- `login_attempts` table for section G: `id uuid pk, key citext, kind text check in ('email','ip'), success bool, created_at timestamptz default now()`. Index on `(key, kind, created_at)`. RLS: deny all (only edge functions touch it via service role).
- `admin_actions` table for section K: `id uuid pk, actor_user_id uuid, action text, target_user_id uuid null, target_resource_type text null, target_resource_id uuid null, details jsonb default '{}', created_at timestamptz default now()`. Index on `(created_at desc)` and `(actor_user_id, created_at desc)`. RLS: admin select only; insert via service role from edge functions.

**Frontend `/admin/users`**:
- New "Last name" column between Name and Email (shows "—" when null).
- Add-user modal: Last name input between Name and Email with helper text.
- Manage drawer: editable Last name field.
- Import CSV modal:
  - **"Download CSV template"** button at top — generates `users_import_template.csv` client-side via Blob with header `name,last_name,email,password,telegram_username,role` and 5 example rows (mix of student/admin, with/without telegram, with/without password).
  - Updated parser handles new column order; existing 5-column CSVs still parse (treat 5-col as legacy: name,email,password,telegram,role).
  - Live preview table with columns Name | Last name | Email | Telegram | Role | Status; invalid rows tinted red.
  - Import button shows valid count.
- Bulk **"Resend welcome email"** action on selected users (adds row checkboxes to the table).

**Frontend `/signup`**: Optional Last name input between Name and Email.

**Frontend `/settings`**: Editable Last name in Profile card.

**Frontend `/dashboard`**: Welcome shows `{name} {last_name}` when available, else `{name}`.

**Edge function `admin-create-students`** updates:
- Accepts `last_name`, writes to `profiles.last_name`.
- New flag `send_invite: boolean` — when true OR when password is blank, generates a strong random password and immediately calls `admin.generateLink({ type: 'magiclink', email, options: { redirectTo: `${origin}/reset-password` } })` so the invite email lands and the user is taken to set their own password.
- New action: `resend_welcome` — for existing users, regenerates the magic link.
- Logs `csv_import_users` and `resend_welcome_email` rows into `admin_actions`.

**Email delivery**: I'll use Supabase Auth's built-in `generateLink` + `inviteUserByEmail` — these go through default Lovable Cloud auth emails. **Not scaffolding custom branded auth-email-hook templates** unless you ask (that's a separate flow with its own DNS verification gates). The invite text is the default "Set up your account" — students click it, land on `/reset-password`, set password, signed in.

### C. Magic-link sign-in + reset-password polish

- `/login`: existing "Email me a sign-in link instead" checkbox already works (uses `signInWithOtp`). I'll surface it as an explicit visible button "Sign in with magic link" alongside Google/Telegram, not buried as a checkbox.
- `/reset-password`: add show/hide password toggle, min 8 chars validation, success toast "Welcome!", auto-redirect to `/dashboard` after update.

### F. Recent sign-ins in /settings

- Read last 10 rows from `auth_events` for current user (table already exists with RLS).
- New "Recent sign-ins" card showing: relative date ("2 hours ago"), absolute datetime on hover, parsed browser from user_agent, "Current session" badge on the most recent matching the live session.
- "Sign out everywhere except this device" button → calls `supabase.auth.signOut({ scope: 'others' })`.
- IP city/country: parsing IP from user_agent isn't possible; `auth_events.ip` is currently unused. I'll start writing IP via a small new edge function `log-auth-event` called from `AuthContext` on `SIGNED_IN`, which reads `cf-connecting-ip` / `x-forwarded-for`. City/country lookup deferred (would need ip-api.com call per event; can add in v1.5). For now show IP only if available.

### G. Soft lockout with clear countdown

- New edge function `login-guard` called by `/login` BEFORE `signInWithPassword`.
  - Counts failed attempts in `login_attempts` for `(email)` and `(ip)` in last 10 min.
  - If ≥5 failures: returns `{ locked: true, locked_until_ms, message }` with HTTP 429.
  - Otherwise returns `{ locked: false }`.
- After `signInWithPassword`, frontend posts result back to `login-guard` (`record-attempt` action) so it logs success/fail. (Two round-trips, but keeps RLS simple.)
- `/login` shows a live countdown banner (updates every second) when locked, with prominent "Reset password" link.
- Admin "Clear lockout" button in Manage drawer (visible only when active lockout exists for that email) → calls edge function to delete recent rows.

### K. Admin actions audit log

- All existing admin write actions (promote/demote, deactivate/activate, delete user, CSV import, clear lockout, resend welcome, create/publish/unpublish/delete course, create/delete lesson) get an `admin_actions` insert from the edge function or via a thin `log-admin-action` helper called from the frontend (only for actions that don't already go through an edge function).
- `/admin/dashboard`: new "Recent admin actions" card showing last 25 entries (actor name, action, target, time-ago).
- New `/admin/audit` page: full table, date range filter, actor filter, expandable row to show jsonb `details` payload.
- Add route + admin nav link.

### L. Tab title

- `index.html` already says "AI Creators" — confirmed nothing to fix. (Spec mentioned "AI CRETATORS" → not present in code; will leave as-is.)

### Lightweight suspicious-login flag (subset of E)

- In `AuthContext` on `SIGNED_IN`, compare current user_agent fingerprint against last 5 auth_events. If new fingerprint, show a one-time toast: "New sign-in detected from [browser]. If this wasn't you, change your password." with a link to /settings → "Recent sign-ins". **No email send** (that needs branded transactional templates → v1.5).

## ⏸ Deferred to v1.5 (with reasons)

- **B. Passkeys (WebAuthn)** — needs `@simplewebauthn/server`, a `user_passkeys` table, 4 new edge functions, real-device testing on the actual published domain (RP ID locked to hostname). Doable but a 1-day standalone task.
- **D. Trusted devices / "Remember this device"** — needs HttpOnly cookie infrastructure (Supabase session cookies are domain-locked; setting our own auth-bypass cookie has security implications — needs careful design).
- **E. Suspicious-login email alerts** — needs ip-api.com integration + branded transactional email template + `/lock-account` endpoint with one-time token. The lightweight UI toast above is the 80/20.
- **H. Cloudflare Turnstile** — requires you to provide site key + secret. I'll add the input fields in /admin/settings during this pass so you can paste them, but the widget+verification wiring lands in v1.5.
- **I. TOTP 2FA required for admins** — Supabase MFA enrollment UI (QR + 6-digit verify + backup codes), gating middleware, /settings/2fa-setup page, banner. Multi-day; needs your phone to test.
- **J. Single-session admin** — needs a session heartbeat polling pattern (Supabase doesn't expose session-id-by-user); risk of false sign-outs during refresh. Wants careful design.

## Files I'll create / edit

**Migrations:**
- 1 new SQL migration: `profiles.last_name`, `login_attempts` table, `admin_actions` table, RLS policies, indexes.

**Edge functions:**
- `admin-create-students/index.ts` — extend with last_name, send_invite, resend_welcome, audit logging.
- New `login-guard/index.ts` — check + record attempts, return lock state.
- New `log-admin-action/index.ts` — small helper for frontend-initiated admin actions to log to audit table.
- New `log-auth-event/index.ts` — capture IP from request headers on sign-in.

**Frontend:**
- `src/pages/admin/AdminUsers.tsx` — last_name column, modal field, drawer field, CSV template download, bulk resend, manage-drawer clear-lockout.
- `src/pages/Signup.tsx` — last_name field.
- `src/pages/Settings.tsx` — last_name field, Recent sign-ins card, sign-out-others button.
- `src/pages/Dashboard.tsx` — full-name welcome.
- `src/pages/Login.tsx` — magic-link button surfaced; lockout countdown banner; login-guard call.
- `src/pages/ResetPassword.tsx` — show/hide toggle, min-8 validation, redirect to /dashboard.
- `src/pages/admin/AdminDashboard.tsx` — Recent admin actions card.
- New `src/pages/admin/AdminAudit.tsx` — full audit log page.
- `src/App.tsx` — register /admin/audit route.
- `src/components/Layout.tsx` (admin nav) — add "Audit log" link.
- `src/contexts/AuthContext.tsx` — call log-auth-event on SIGNED_IN; emit suspicious-login toast on new fingerprint.

## Self-test plan (what I'll actually verify)

1. ✅ Migration applies; `last_name`, `login_attempts`, `admin_actions` exist with correct RLS.
2. ✅ `/admin/users` shows Last name column.
3. ✅ Download CSV template button produces correct file.
4. ✅ Parsing a CSV with new format renders preview correctly.
5. ✅ Edge function deploys; calling `admin-create-students` with `send_invite=true` returns a magic link URL.
6. ✅ Soft lockout: 5 fake failed attempts via `login-guard` returns 429 with countdown.
7. ✅ Admin audit log records entries; `/admin/dashboard` and `/admin/audit` render them.
8. ✅ `/dashboard` shows full name.
9. ✅ `/settings` Recent sign-ins reads from `auth_events`.

**Cannot self-test without your help**: real magic-link email delivery (depends on Lovable Cloud email pipeline + your inbox); Telegram round-trip (needs your domain + Telegram account); browser-specific UX (passkeys, TOTP — these aren't in scope anyway).

## After approval

I'll build it all in one go, deploy edge functions, run a security scan, and report back what landed + what to test manually.