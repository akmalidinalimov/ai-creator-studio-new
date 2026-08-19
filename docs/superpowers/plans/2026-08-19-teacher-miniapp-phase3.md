# Teacher Mini App — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This repo has **no frontend unit-test harness**; the frontend verification bar is `npm run typecheck` (tsc — the real gate) + `npm run build`, and prod E2E. The edge function is verified with `deno check` + prod E2E. Task "verify" steps use those.

**Goal:** Ship the teacher Mini App's last two screens — **Broadcast** (compose a message → fan it out as DMs to a chosen group's students) and **Nudge** (list students gone quiet → one-tap "we miss you" DM) — wiring the two remaining Home tiles (Xabar, Nudge) and the Phase-2 student-detail nudge stub live.

**Architecture:** One new SECURITY-conscious **edge function** `teacher-broadcast-group` that mirrors the existing bot `/tbroadcast` DM-fan-out (NOT a supergroup post) — authed teacher → `is_group_teacher` gate → resolve the group's students with a `telegram_id` → `sendMessage` fan-out with the "message from teacher" prefix → per-recipient + teacher rate-ledger rows → DB-visible health signal. Nudge needs **no new backend**: it reuses `teacher-nudge-student` (junction-aware `is_teacher_of`, 1/day rate-limit, already returns every state) and reads the inactive list from `staff_group_members.last_activity_at`. Both screens are frontend on the Phase-1 session gate + `TeacherShell`, reusing `useSelectedGroup` (Phase 2) for the active group.

**Tech Stack:** React 18 + Vite + TS + React Router, Tailwind + `ui-kit`, Supabase RLS/RPCs + edge functions (Deno), Telegram Bot API (server-side token).

**Spec:** `docs/superpowers/specs/2026-08-18-teacher-miniapp-design.md` (Phase 3 = Broadcast §"Broadcast" + Nudge §"Nudge"; and the Phasing note: "re-skin the existing `TgBroadcast` flow; nudge reuses `teacher-nudge-student` + the engagement-nudge cron's inactivity definition, with anti-spam cooldown + can't-DM + already-nudged states").

## Global Constraints

- **Branch:** `feat/teacher-miniapp-phase3` off current `main` (which has Phase 1 #88 + incident #89 + Phase 2 #90). Never merge to `main` without the owner's explicit "merge it".
- **Never `git add -A`** (chronically dirty `.env`/`deno.lock`/`scripts/`) — stage explicit paths only.
- **Never log, commit, or return the bot token or a raw `api.telegram.org/bot<token>/…` URL.** The token stays server-side in the edge function; the client never sees it. (This is the T2 hw-image-url leak class — do not repeat it.)
- **Junction-aware everywhere:** every teacher→group / teacher→student check must admit co-teachers. Backend uses `is_group_teacher(_group_id,_uid)` / `is_teacher_of(_student,_teacher)` (both junction-aware since Feature 2 #86). Frontend group reads use `teacher_groups` / `useSelectedGroup`. Never filter `groups.teacher_id` directly. `.rpc("name" as any, …)` / `.functions.invoke("name")` casts where generated types lack them (frontend-typecheck-verify convention).
- **Mirror the existing `/tbroadcast` behavior exactly** (it is the reviewed, shipped path): DM fan-out to the group's students (each a private DM), the `teacherFromTeacher(groupName)` prefix, a **300-char** message cap, and the **1-per-hour** teacher rate-limit via `bot_broadcast_rate` (scope `"teacher"`). Do NOT introduce a supergroup-chat post (different bot-admin permission surface, out of scope).
- **DB-visible health signal (incident doctrine, MANDATORY):** the new edge fn must emit a DB-visible signal for both success and fault — a broadcast row in `admin_actions` (action `teacher_broadcast_miniapp`, with actor/group/sent/total) and `logError` on any send exception (the webhook's existing fault path). Errors that live only in function logs are invisible to the watchdog layer.
- **Design:** dark-only, mobile-first, `max-w-2xl`, EXACTLY ONE `Button variant="primary"` (`bg-cta` coral) per screen, ui-kit components by name (no old `ui/*`), `truncate`/`min-w-0` (no horizontal scroll), Telegram safe-area (the shell handles it). Screens render inside `TeacherShell` — content-only, no shell/nav chrome.
- **States on every screen:** loading (`Skeleton`), empty (`EmptyState`), error/offline (`navigator.onLine`-aware `EmptyState` + retry). Copy the Phase-1/2 pattern (`TeacherHome.tsx` / `TeacherGroups.tsx`).
- **Staff-only:** routes are `RequireAuth staffOnly` (the `/tg/teacher/*` pattern in `App.tsx`). The Phase-1 `platform_settings.teacher_miniapp` kill-switch still gates the whole Mini App entry.
- **Uzbek-first copy** (uz primary; ru/en where the app already localizes). Match the tone of the existing teacher strings.

## Confirmed contracts (verified live in the codebase — do not re-guess)

- **`teacher-nudge-student`** edge fn — body `{ student_id: uuid }`, `Authorization: Bearer <session jwt>`. Returns: `{ ok: true }` (200) on send; `{ error }` with status — `unauthorized` 401, `student_id required` 400, `forbidden` 403 (not this student's teacher/admin), `already_nudged_today` 429, `no_telegram` 400 (**student never pressed Start / no telegram_id = can't-DM**), `send_failed`/telegram description 502, `unknown` 500. Junction-aware via `is_teacher_of`. Rate-limit is 1/24h/student across ALL senders (`notifications_log` type `teacher_nudge`).
- **`staff_group_members(_group_id uuid)`** — junction-gated roster. Returns `(id uuid, name text, last_name text, email text, telegram_username citext, telegram_id bigint, last_sign_in_at timestamptz, last_activity_at timestamptz, completed_lessons int, avg_score int)`. `last_activity_at = max(lesson_progress.updated_at)` (NULL if the student never progressed). This is the **inactivity source** for Nudge.
- **`is_group_teacher(_group_id uuid, _uid uuid) → boolean`** — junction-aware group-teacher gate (primary ∪ `group_teachers`).
- **`bot_broadcast_rate`** — rate ledger. Rows: `{ actor_user_id, scope, recipient_user_id?, created_at }`. The existing teacher rate-limit: `count(scope='teacher', actor_user_id=teacher, created_at >= now()-1h) >= 1` ⇒ blocked. Per-recipient rows use `scope='recipient'`. A final `{ actor_user_id, scope:'teacher' }` row stamps the send.
- **`teacherFromTeacher(groupName)` prefix** (webhook `index.ts`): uz `📣 <b>O'qituvchidan xabar — {n}</b>\n\n`, ru `📣 <b>Сообщение от преподавателя — {n}</b>\n\n`, en `📣 <b>Message from teacher — {n}</b>\n\n`. The body is `prefix + HTML-escaped(text)`, sent with `parse_mode: HTML`.
- **`useSelectedGroup()`** (Phase 2, `src/hooks/useSelectedGroup.ts`) → `{ groupId, setGroupId, groups, loading, error, reload }`. `groups` come from `teacher_groups` (junction-aware). Persisted per-user in localStorage.
- **Existing `/tbroadcast` reference:** `handleTeacherSession` in `supabase/functions/telegram-bot-webhook/index.ts:4343-4386` — the authoritative behavior to mirror (rate-check, `teacherStudentIds(teacher, groupId)`, filter `telegram_id`, fan-out, per-recipient + teacher rows, `logError` on throw). Read it before Task 1.

Each implementer MUST read the referenced source (the fn/RPC/screen) for exact field names before building against it — do NOT assume.

---

## Task 1: `teacher-broadcast-group` edge function (the one new backend)

**Files:**
- Create: `supabase/functions/teacher-broadcast-group/index.ts`
- Modify: `supabase/config.toml` — add `[functions.teacher-broadcast-group]` (mirror the `teacher-nudge-student` block; if that fn has no explicit block, add one with `verify_jwt = true`). NOTE: any `config.toml` change makes the deploy pipeline redeploy ALL edge functions — that is expected and how a new function ships.
- Reference (read first, do not modify): `supabase/functions/telegram-bot-webhook/index.ts:4343-4386` (`handleTeacherSession` — the behavior to mirror) and `supabase/functions/teacher-nudge-student/index.ts` (the auth + service-role + CORS skeleton to copy).

**Interfaces — Produces:** `POST /functions/v1/teacher-broadcast-group`, body `{ group_id: uuid, message: string }`, `Authorization: Bearer <session jwt>`. Returns:
- `{ ok: true, sent: number, total: number, skipped_no_telegram: number }` (200)
- `{ error: "unauthorized" }` 401 · `{ error: "group_id and message required" }` 400 · `{ error: "message_too_long" }` 400 (>300 chars) · `{ error: "forbidden" }` 403 (not this group's teacher/admin) · `{ error: "rate_limited" }` 429 (a teacher-scope broadcast within the last hour) · `{ error: "no_recipients" }` 200-or-400 (group has zero students with a telegram_id) · `{ error: "unknown" }` 500.
Consumed by Task 2.

- [ ] **Step 1:** Read the two reference files. Copy the `teacher-nudge-student` skeleton: CORS headers, `json()` helper, `admin` (service-role) + `anon` (caller-JWT) clients, `anon.auth.getUser()` → 401 if no user.
- [ ] **Step 2:** Parse `{ group_id, message }`. Validate: both present (400 `group_id and message required`); `message.trim()` non-empty; `message.trim().length <= 300` else 400 `message_too_long` (mirror the webhook's 300 cap).
- [ ] **Step 3:** Authorize. Call `admin.rpc("is_group_teacher", { _group_id: group_id, _uid: who.user.id })` AND read `user_roles` for admin/superadmin (mirror the nudge fn's dual check). If neither ⇒ 403 `forbidden`. Junction-aware by construction.
- [ ] **Step 4:** Rate-limit. `admin.from("bot_broadcast_rate").select("id",{count:'exact',head:true}).eq("actor_user_id", who.user.id).eq("scope","teacher").gte("created_at", new Date(Date.now()-3600_000).toISOString())`. If `count >= 1` ⇒ 429 `rate_limited`.
- [ ] **Step 5:** Resolve recipients + group name. Group name: `admin.from("groups").select("name").eq("id", group_id).maybeSingle()`. Students: `admin.from("profiles").select("id, telegram_id, preferred_locale, name").eq("group_id", group_id)`, then `recipients = rows.filter(r => r.telegram_id)`. If `recipients.length === 0` ⇒ delete no session (there is none), return `{ error: "no_recipients" }` (400). Track `total = recipients.length` and count `skipped_no_telegram = rows.length - recipients.length`.
- [ ] **Step 6:** Build the body with the teacher's locale-appropriate prefix. Read the teacher's `preferred_locale` (`admin.from("profiles").select("name, preferred_locale").eq("id", who.user.id).maybeSingle()`) and pick uz/ru/en; default uz. Inline the three `teacherFromTeacher` prefixes (copy verbatim from the webhook) and an HTML-escape helper (copy `csvEscapeHtml` or a minimal `&<>` escaper). `body = prefix(groupName) + escape(message.trim())`.
- [ ] **Step 7:** Fan out. For each recipient: `fetch(https://api.telegram.org/bot${Deno.env.get("TELEGRAM_BOT_TOKEN")}/sendMessage, { method:POST, body: { chat_id: Number(r.telegram_id), text: body, parse_mode: "HTML" } })`. On a thrown exception (network fault — NOT a Telegram "blocked bot" ok:false, which does not throw), `logError(admin, "teacher-broadcast-group", e, { action:"teacher_broadcast_miniapp_send", user_id: r.id })` and continue. On ok, insert `bot_broadcast_rate { actor_user_id: who.user.id, recipient_user_id: r.id, scope:"recipient" }` and `sent++`. (Copy `logError` inline or import the shared helper if one exists under `_shared`.)
- [ ] **Step 8:** Stamp the send + health signal. Insert the teacher rate row `bot_broadcast_rate { actor_user_id: who.user.id, scope:"teacher" }`. Insert the DB-visible health row `admin.from("admin_actions").insert({ action:"teacher_broadcast_miniapp", actor_id: who.user.id, ... })` — FIRST read `admin_actions` columns (grep a recent insert, e.g. the webhook's `admin_actions` writes) and match its real shape (actor/target/action/details); put `{ group_id, sent, total, skipped_no_telegram }` in the details/jsonb column. Return `{ ok:true, sent, total, skipped_no_telegram }`.
- [ ] **Step 9 (verify):** `deno check supabase/functions/teacher-broadcast-group/index.ts` clean (run from repo root; if `deno` is unavailable locally, note it and rely on the CI Edge check). Manually re-read the diff for: no token in any return/log, 300-cap enforced, `is_group_teacher` gate present, rate-limit present, health row written. Commit (explicit paths: the new fn + `config.toml`).

**This task's diff MUST get a `telegram-flow-reviewer` pass** (Telegram-sensitive: token handling, rate-limit, fan-out, chat_id typing) before the branch PR. The controller dispatches it as part of the task review.

---

## Task 2: Broadcast screen (`/tg/teacher/broadcast`) + live Home "Xabar" tile

**Files:**
- Create: `src/pages/teacher/TeacherBroadcast.tsx`
- Modify: `src/App.tsx` — register `/tg/teacher/broadcast` (staff-guarded, in `TeacherShell`).
- Modify: `src/pages/teacher/TeacherHome.tsx` — make the **Xabar** tile live (route to `/tg/teacher/broadcast`; remove its "tez orada"/disabled state).
- Reference: `src/hooks/useSelectedGroup.ts` (group picker source), `src/pages/TgBroadcast.tsx` if it exists (the existing broadcast UI to re-skin — grep first), `src/pages/teacher/TeacherGrade.tsx` (the ui-kit form + `functions.invoke` + toast pattern).

**Interfaces — Consumes:** `useSelectedGroup()` for the group; the `teacher-broadcast-group` fn from Task 1 (`supabase.functions.invoke("teacher-broadcast-group", { body: { group_id, message } })`).

- [ ] **Step 1:** Read `useSelectedGroup`, `TeacherHome.tsx` (how tiles route + how "tez orada" is styled), and how another screen calls an edge fn (`supabase.functions.invoke` + error handling; grep `functions.invoke` in `src/`).
- [ ] **Step 2:** Build `TeacherBroadcast.tsx`: a group selector (from `useSelectedGroup` — if only one group, show its name, no picker; if 2+, a segmented/select control that calls `setGroupId`); a `<textarea>` (maxLength 300, live `N/300` counter, `min-w-0`); the single coral `Button variant="primary"` = "Yuborish" (Send), disabled while empty or sending.
- [ ] **Step 3:** On send: `functions.invoke("teacher-broadcast-group", { body: { group_id: groupId, message } })`. Map the result: `ok` → success `EmptyState`/toast "Xabar N ta o'quvchiga yuborildi" (sent N of total; if `skipped_no_telegram>0` add a muted note "M ta o'quvchi Telegram'ni ulamagan"); `rate_limited` → "Soatiga 1 marta — birozdan keyin qayta urining"; `no_recipients` → "Bu guruhda Telegram'li o'quvchi yo'q"; `forbidden` → "Ruxsat yo'q"; `message_too_long` → guarded client-side already. Never surface a raw 500 body — show a generic retry.
- [ ] **Step 4:** States: no-groups `EmptyState` ("Sizda guruh yo'q"); sending spinner on the button; `navigator.onLine` offline guard before invoke (show retry). Confirm exactly one primary button. `truncate` the group name.
- [ ] **Step 5:** Wire `App.tsx` route + the live Home Xabar tile.
- [ ] **Step 6 (verify):** `npm run typecheck` + `npm run build` clean. Reason: a teacher/co-teacher picks a group, composes ≤300 chars, sends; success shows the sent count; rate-limit + no-recipients + offline render their states; token never reaches the client (it is the fn's concern, but confirm the invoke passes only `{group_id, message}`). Commit (explicit paths).

---

## Task 3: Nudge screen (`/tg/teacher/nudges`) + live Home "Nudge" tile + student-detail nudge

**Files:**
- Create: `src/pages/teacher/TeacherNudges.tsx`
- Modify: `src/App.tsx` — register `/tg/teacher/nudges` (staff-guarded, in `TeacherShell`).
- Modify: `src/pages/teacher/TeacherHome.tsx` — make the **Nudge** tile live (route to `/tg/teacher/nudges`).
- Modify: `src/pages/teacher/TeacherStudentDetail.tsx` — replace the Phase-2 "tez orada" Nudge stub with a real one-tap nudge (same invoke + state handling as this screen, scoped to the one student).
- Reference: `src/hooks/useSelectedGroup.ts`; the `teacher-nudge-student` contract above; `TeacherGroups.tsx` (roster row + states pattern).

**Interfaces — Consumes:** `useSelectedGroup()` for the group; `staff_group_members(groupId)` for the roster + `last_activity_at`; `teacher-nudge-student` (`supabase.functions.invoke("teacher-nudge-student", { body: { student_id } })`).

- [ ] **Step 1:** Read `teacher-nudge-student`'s contract (above — all states), `staff_group_members` columns (`last_activity_at`, `telegram_id`), and confirm the inactivity threshold. Default **inactive = `last_activity_at` older than 7 days OR NULL**; grep `supabase/functions/detect-and-nudge` / `cron-teacher-engagement-nudge` for the cron's exact "gone quiet" window and match it if it differs from 7d (leave a code comment naming the source).
- [ ] **Step 2:** Build `TeacherNudges.tsx`: group selector (reuse `useSelectedGroup` like Task 2). Load `staff_group_members(groupId)`; compute `inactive = members.filter(m => !m.last_activity_at || m.last_activity_at < sevenDaysAgo)`. Sort most-inactive first. Each row: name (`truncate`), "oxirgi faollik: X kun oldin" (or "hech qachon"), and a per-row action button. A student with no `telegram_id` shows a disabled "Telegram ulanmagan" chip instead of the nudge button (pre-empt the `no_telegram` state).
- [ ] **Step 3:** Per-row nudge: on tap, `functions.invoke("teacher-nudge-student", { body: { student_id: m.id } })`, with per-row pending/disabled state. Map: `ok` → row shows "✅ Yuborildi" and disables; `already_nudged_today` → "Bugun yuborilgan" (disable); `no_telegram` → "Telegram ulanmagan" (disable); `forbidden` → generic error toast; other → generic retry. One-tap only; never double-send (disable on click). The single coral primary is optional on a list screen (per Phase-2 convention) — the per-row buttons can be `variant="secondary"`; if you want a primary, a "Hammaga eslatma" (nudge-all) is OUT of scope (respect the 1/day + anti-spam) — do NOT add a bulk button.
- [ ] **Step 4:** States: `Skeleton` loading; `EmptyState` no-groups ("Sizda guruh yo'q") and no-inactive ("🎉 Hamma faol — hech kim uxlab qolmagan"); `navigator.onLine` offline retry. No horizontal scroll.
- [ ] **Step 5:** Wire `App.tsx` route + the live Home Nudge tile. Then wire `TeacherStudentDetail.tsx`: swap its "tez orada" nudge stub for a real button using the identical invoke + state mapping (scoped to that one student). Keep it one action, disabled after send/already-nudged/no-telegram.
- [ ] **Step 6 (verify):** `npm run typecheck` + `npm run build` clean. Reason: a teacher/co-teacher opens Nudge → sees only their group's inactive students → taps one → gets the ok / already-nudged / can't-DM state inline, never double-sends; student-detail nudge works the same; empty + offline states render. Commit (explicit paths).

---

## Verification (whole Phase 3, on prod after merge)

E2E with a real teacher (Guli/Feruza/Rano) or a synthetic co-teacher (`admin-create-students` + `group_teachers` insert; DELETE after, assert zero residue):
- **Broadcast:** compose a test message to a group → confirm the sent count matches the group's telegram-linked students; confirm the DM arrives with the "O'qituvchidan xabar — {group}" prefix; immediately retry → `rate_limited`; confirm a `bot_broadcast_rate scope='teacher'` row + an `admin_actions teacher_broadcast_miniapp` health row landed. Confirm the bot token appears in NO client response or log.
- **Nudge:** open Nudge for a group with a known-inactive, telegram-linked student → tap → DM arrives → row shows "Yuborildi"; retry same student → `already_nudged_today`; a student with no telegram_id shows the disabled chip (no send attempt). Confirm a `notifications_log teacher_nudge` row.
- **Co-teacher parity:** Rano (co-teacher on 1-GURUH PRE) can broadcast + nudge that group's students (junction-aware gates admit her).
- Confirm no XP/grade mutation (these screens don't touch XP).

## Self-review (done at write time)

- **Spec coverage:** Broadcast screen + fan-out (T1 fn + T2 screen) / Nudge screen + inactive list + reuse of `teacher-nudge-student` (T3) / Home Xabar + Nudge tiles live (T2, T3) / student-detail nudge (T3) / anti-spam + can't-DM + already-nudged states (T3, from the fn's real return codes) — all Phase-3 spec items mapped. The spec's "send to the group's Telegram chat" is implemented as the existing DM fan-out per the more-specific "re-skin the existing TgBroadcast flow" instruction (Global Constraints call this out); a supergroup post is explicitly out of scope.
- **Placeholder scan:** every state maps to a real return code from a verified contract (no "handle errors" hand-waving); the inactivity threshold is a concrete 7d default with a named source to confirm; `admin_actions` shape is "grep and match", not assumed.
- **Type consistency:** the fn's `{ ok, sent, total, skipped_no_telegram }` shape (T1 Produces) is consumed verbatim in T2 Step 3; `useSelectedGroup()`'s `{ groupId, setGroupId, groups }` (Phase 2) is consumed in T2 + T3; `teacher-nudge-student`'s state codes (`ok`/`already_nudged_today`/`no_telegram`/`forbidden`) are mapped identically in T3's screen and student-detail wiring.
- **Security:** token stays server-side (Global Constraint + T1 Step 7/9 + verify); every gate is junction-aware (`is_group_teacher`/`is_teacher_of`); rate-limits mirror the shipped path (1/hr broadcast, 1/day nudge); DB-visible health signal satisfies the incident doctrine.
