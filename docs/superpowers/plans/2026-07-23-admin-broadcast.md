# Admin Broadcast Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with an independently testable/reviewable deliverable. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let admins send an image+message announcement to all students of one selected course as a Telegram DM, from a new `/admin/broadcast` screen, delivered reliably via a queue + cron drainer.

**Architecture:** Admin composes in a React admin page → an admin-JWT edge function (`admin-broadcast`) creates a `broadcasts` row and fans out one `broadcast_deliveries` row per targeted student → a once-a-minute `broadcast-drainer` edge function sends each via the bot token, classifying success/terminal/transient (the PR #36 reliability model) → the page polls a status RPC for a live delivered/failed report.

**Tech Stack:** Supabase Postgres + RLS + pg_cron + pg_net, Deno edge functions, Telegram Bot API (`sendPhoto`/`sendMessage`), React + Vite + react-i18next, Supabase Storage (public bucket).

## Global Constraints (verbatim from spec / CLAUDE.md)
- Delivery is **Telegram DM only**; composed in the platform. No in-app inbox.
- Target = **enrolled + active + Telegram-linked** students of the chosen course.
- Language: **`body_uz` required**, `body_ru`/`body_en` optional overrides; student `preferred_locale` picks, missing → uz.
- Telegram limits: **caption ≤1024 (with image)**, **text ≤4096 (no image)**.
- Reliability: `tg()` must check the Telegram `ok` field; failures classified terminal vs transient; **never mark a failed send as sent** (badge-bug lesson). Atomic claim (last_attempt_at lease) to avoid double-send. Retry cap 5.
- New service-role-only tables: RLS enabled, no policies. New SECURITY DEFINER fns: `set search_path=public`, revoke public/anon/authenticated, grant service_role.
- New edge functions MUST be in `supabase/config.toml`.
- New migration applies on merge only with `migration-approved` label; drainer cron authed via `cron_service_key()`+`internal_fn_secret()` (canary pattern).
- Ships dormant-safe: kill-switch `platform_settings.broadcast.enabled` (default false); UI + page visible, sends blocked until owner flips it on.

---

## File Structure
- **Create** `supabase/migrations/20260723xxxxxx_admin_broadcast.sql` — 2 tables, indexes, RLS, `broadcast-images` bucket, status/reachable RPCs, kill-switch seed, drainer cron, digest superset + watchdog.
- **Create** `supabase/functions/admin-broadcast/index.ts` — admin-JWT gated; create broadcast + fan-out.
- **Create** `supabase/functions/broadcast-drainer/index.ts` — cron/x-internal-secret; send + classify.
- **Create** `supabase/functions/broadcast-drainer/classify.ts` + `classify.test.ts` — pure send-outcome classification, Deno-tested.
- **Modify** `supabase/config.toml` — add `[functions.admin-broadcast]` (verify_jwt=true) + `[functions.broadcast-drainer]` (verify_jwt=false).
- **Create** `src/pages/admin/AdminBroadcast.tsx` — the composer screen.
- **Modify** `src/App.tsx` — add `/admin/broadcast` route (adminOnly).
- **Modify** `src/components/admin/AdminSidebar.tsx` — add nav item.
- **Modify** `src/i18n/locales/{uz,ru,en}.json` — page strings.

---

### Task 1: Migration — tables, RLS, bucket, RPCs, kill-switch, cron, digest+watchdog
**Files:** Create `supabase/migrations/20260723xxxxxx_admin_broadcast.sql`
**Produces (interfaces later tasks rely on):**
- `public.broadcasts(id uuid pk, course_id uuid, created_by uuid, image_path text, body_uz text not null, body_ru text, body_en text, button_label text, button_url text, mode text check in ('test','all'), status text check in ('sending','done') default 'sending', total int default 0, sent int default 0, failed int default 0, created_at, started_at, finished_at timestamptz)`
- `public.broadcast_deliveries(id bigint identity pk, broadcast_id uuid fk, user_id uuid, telegram_id text, status text check in ('pending','sent','failed') default 'pending', error text, attempts int default 0, last_attempt_at timestamptz, sent_at timestamptz)`; index `(broadcast_id)`, partial index `(broadcast_id) where status='pending'`.
- RPC `public.broadcast_reachable(_course_id uuid) returns int` (SECURITY DEFINER, admin-only via `has_role`) — count enrolled+active+telegram-linked.
- RPC `public.broadcast_status(_broadcast_id uuid) returns jsonb` (admin-only) — `{status,total,sent,failed,pending}`.
- kill-switch: `platform_settings` key `broadcast` = `{"enabled": false}`.
- Storage: `insert into storage.buckets (id,name,public) values ('broadcast-images','broadcast-images',true)`; policy: admins can upload/read.
- Cron `broadcast-drainer-every-minute` (`* * * * *`) → net.http_post drainer with `cron_service_key()`+`internal_fn_secret()`.
- `ops_daily_digest()` faithful-superset: add a broadcast line (last 24h sent/failed) + fold a stuck-broadcast condition into the alarm. `broadcast_health_stats()` returning jsonb; `broadcast_watchdog()` (cron */30) DMs admins if a `sending` broadcast has pending rows older than 30 min.
- [ ] Write the migration (DDL idempotent: `create table if not exists`, `create index if not exists`, `on conflict` for settings/bucket, unschedule-then-schedule crons).
- [ ] Verify via MCP after merge: tables/RPCs/cron exist; RLS on; ledgered.
- [ ] Commit.

### Task 2: Drainer classification (pure, Deno-tested)
**Files:** Create `supabase/functions/broadcast-drainer/classify.ts` + `classify.test.ts`
**Produces:** `tgResult(j:{ok:boolean;description?:string}, httpStatus:number): {ok:boolean; error:string|null}`; `isTerminal(err:string|null): boolean` (recipient: bot blocked/chat not found/never-initiated/deactivated; content: caption too long/failed to get http url/wrong file). Mirrors `notify-badge-award`'s classifiers.
- [ ] Write `classify.test.ts` covering: ok=true→{ok:true}; `{ok:false,description:"Forbidden: bot was blocked by the user"}`→terminal; `429`/network→transient; caption-too-long→terminal.
- [ ] Run `deno test supabase/functions/broadcast-drainer/` → FAIL.
- [ ] Implement `classify.ts`.
- [ ] Run tests → PASS. Commit.

### Task 3: `broadcast-drainer` edge function
**Files:** Create `supabase/functions/broadcast-drainer/index.ts`
**Consumes:** classify.ts; `broadcast_deliveries`, `broadcasts` tables; env `TELEGRAM_BOT_TOKEN`, `INTERNAL_FN_SECRET`, `SUPABASE_*`.
**Behavior:** x-internal-secret gate. Claim up to 100 `pending` rows atomically (`update ... set last_attempt_at=now() where status='pending' and (last_attempt_at is null or last_attempt_at < now()-90s) returning ...`), grouped per broadcast. For each: load `broadcasts` (image_path→public URL, bodies, button); per recipient pick locale body (fallback uz); `sendPhoto` if image else `sendMessage` (HTML). On ok→status='sent',sent_at; terminal→status='failed',error; transient→attempts+1 (cap5→failed). Update `broadcasts.sent/failed`; when no pending remain for a broadcast, set `status='done',finished_at`. Rate: ~40ms/msg.
- [ ] Implement; unit-test covered by Task 2 classify tests (index wiring verified E2E in Task 8).
- [ ] Commit.

### Task 4: `admin-broadcast` edge function
**Files:** Create `supabase/functions/admin-broadcast/index.ts`
**Consumes:** user JWT (admin/superadmin), `broadcasts`/`broadcast_deliveries`/`enrollments`/`profiles`, kill-switch.
**Behavior:** verify caller is admin (getUser + user_roles). Reject if `broadcast.enabled=false`. Body `{course_id, image_path, body_uz, body_ru?, body_en?, button_label?, button_url?, mode}`. Validate lengths vs image presence. Insert `broadcasts` row. Target = `mode='test'` → caller only; else enrolled+active+telegram-linked of course. Insert `broadcast_deliveries` (pending) in bulk. `admin_actions` audit. Return `{broadcast_id, total}`.
- [ ] Implement. Commit.

### Task 5: `config.toml`
**Files:** Modify `supabase/config.toml`
- [ ] Add `[functions.admin-broadcast]\nverify_jwt = true` and `[functions.broadcast-drainer]\nverify_jwt = false`.
- [ ] Run `node scripts/check-config-toml.mjs` → passes. Commit.

### Task 6: Admin page + route + sidebar + i18n
**Files:** Create `src/pages/admin/AdminBroadcast.tsx`; Modify `src/App.tsx`, `src/components/admin/AdminSidebar.tsx`, `src/i18n/locales/{uz,ru,en}.json`
**Behavior:** course dropdown (supabase `courses` select), reachable count via `broadcast_reachable` RPC, image upload → `broadcast-images` bucket → `image_path`, body_uz textarea + collapsible ru/en, optional button, char counter (1024/4096 by image presence), `Send test to me` (calls `admin-broadcast` mode=test) and `Send to N` (confirm dialog → mode=all), progress via polling `broadcast_status` RPC every 3s until done.
- [ ] Implement page; add route `/admin/broadcast` (RequireAuth adminOnly), sidebar item (icon Megaphone/Send), i18n keys.
- [ ] `npm run build` + typecheck pass. Commit.

### Task 7: Reviews
- [ ] `migration-safety-reviewer` on Task 1 migration.
- [ ] `telegram-flow-reviewer` on Tasks 3+4 (send path, member-forgiveness, rate limits, reach honesty).
- [ ] Fix blocking findings; re-review. Commit.

### Task 8: PR + E2E
- [ ] Open PR (`migration-approved` label). Wait CI green. Owner "merge it".
- [ ] After deploy: verify migration ledgered + functions live (MCP).
- [ ] With `broadcast.enabled=true`: owner `Send test to me` → verify DM arrives; then a small controlled send to ≤3 synthetic students; assert delivered/failed counts; DELETE synthetics.

## Self-Review
- Spec coverage: data model (T1), admin screen (T6), send flow (T3/T4/T6), reliability rails (T2/T3), quiet-hours (T4/T6 — defer field on broadcast: add `scheduled_for` to deliveries or a broadcast-level start; **fold into T4** by scheduling first-send at next 08:00 Tashkent when in quiet hours), guards/kill-switch (T1/T4), health (T1 digest+watchdog), verification (T2 unit, T7 reviews, T8 E2E). Covered.
- Placeholder scan: none.
- Type consistency: `broadcast_id` uuid, `broadcast_deliveries.id` bigint, status enums consistent across tasks.
- **Quiet-hours gap fix:** add `scheduled_for timestamptz default now()` to `broadcast_deliveries`; drainer claims only `scheduled_for <= now()`; `admin-broadcast` sets it to next 08:00 Tashkent for `mode='all'` when currently 22:00–08:00 (test mode always now()).
