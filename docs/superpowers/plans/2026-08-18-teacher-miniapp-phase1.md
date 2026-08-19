# Teacher Mini App — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This repo has **no frontend unit-test harness**; the verification bar is `npm run typecheck` (tsc — the real gate, Vite skips it) + `npm run build`, `deno check` on edge functions, and prod E2E with synthetic users. Task "verify" steps use those, not pytest/jest.

**Goal:** Ship the teacher-side Telegram Mini App shell + routing + the complete mobile grading flow, so a teacher (or co-teacher) opens the bot, lands on a mobile teacher home, and grades homework — photo, score, feedback — on their phone.

**Architecture:** Approach 1 (session gate). Teachers open the Mini App → `tg-miniapp-auth` mints a Supabase session and lands them on `/tg/teacher` (new). New `/tg/teacher/*` routes render inside that authenticated session under a new mobile `TeacherShell` (`TeacherBottomNav`), reusing the Graphite & Emerald `ui-kit`. Grading reads a new junction-aware RPC and writes scores through existing RLS (XP triggers auto-fire). Homework photos resolve through a new edge function that handles both storage-bucket and Telegram-`file_id` media.

**Tech Stack:** React 18 + Vite + TypeScript + React Router, Tailwind + shadcn-derived `ui-kit`, Supabase (Postgres RLS, edge functions on Deno), Telegram WebApp SDK.

**Spec:** `docs/superpowers/specs/2026-08-18-teacher-miniapp-design.md` (read it — this plan implements its Phase 1 only).

## Global Constraints

- **Branch:** `feat/teacher-miniapp` (already exists, spec committed there). Never merge to `main` without the owner's explicit "merge it".
- **Migrations:** append-only; new files apply on merge only with the `migration-approved` label + ledger in `ops_applied_migrations` (never re-applied). Idempotent (`create or replace`, `if not exists`). MCP `execute_sql` is READ-ONLY.
- **Never `git add -A`** (chronically dirty `.env`/`deno.lock`/`scripts/`) — stage explicit paths.
- **Junction-aware everywhere:** "teachers of a group" = `groups.teacher_id` ∪ `group_teachers` (helpers `is_group_teacher`/`teacher_group_ids`, live since #86). Co-teachers must work in every read/write.
- **Design:** dark-only, mobile-first, `max-w-2xl` container, exactly one `Button variant="primary"` (`bg-cta` coral) per screen, ui-kit components by name (no old `ui/*`), `truncate`/`min-w-0` (no horizontal scroll), Telegram safe-area vars.
- **Verification bar:** after XP-touching changes confirm totals settle (xp_events ref-keyed). Telegram: callback_data ≤64B; bots can't DM users who never pressed Start. E2E on prod with synthetic users, then DELETE (zero residue).
- **Staff-only:** `/tg/teacher/*` is teacher/admin only; students must never reach it. Kill-switch via `platform_settings`.

---

## File Structure

**New (frontend):**
- `src/pages/teacher/TeacherHome.tsx` — `/tg/teacher` home.
- `src/pages/teacher/TeacherGrade.tsx` — `/tg/teacher/grade` grading queue (the centerpiece).
- `src/components/teacher/TeacherShell.tsx` — mobile shell wrapper (viewport/safe-area + `TeacherBottomNav`).
- `src/components/teacher/TeacherBottomNav.tsx` — 4-tab bottom nav (clone of `StudentBottomNav`).
- `src/components/teacher/GradePhoto.tsx` — homework photo with lightbox/zoom + degraded state.
- `src/hooks/usePendingGrading.ts` — pending-count hook (mirrors `usePendingHomework`).
- `src/lib/teacherApi.ts` — typed wrappers for the RPC + resolver + score write.

**New (backend):**
- `supabase/migrations/<ts>_teacher_pending_submissions.sql` — the grading-queue RPC + a `platform_settings.teacher_miniapp` kill-switch row.
- `supabase/functions/hw-image-url/index.ts` — resolve a submission's viewable image URL (storage signed URL OR Telegram `file_id` proxy).

**Modified:**
- `supabase/functions/tg-miniapp-auth/index.ts` — role-aware `target_path` (staff → `/tg/teacher`).
- `src/components/.../TelegramGate.tsx` — honor a `/tg/teacher*` open (don't clobber with the default target).
- `src/App.tsx` — register `/tg/teacher` + `/tg/teacher/grade` under staff guard.
- `src/lib/telegram/useTelegramBackButton.ts` — add `/tg/teacher` to `ROOT_PATHS`.
- `src/components/Layout.tsx` (`PageShell`) — branch to `TeacherShell` for `/tg/teacher/*` (or leave PageShell untouched and wrap the routes directly in `TeacherShell` — see Task 4).
- `supabase/functions/telegram-bot-webhook/index.ts` — `📝 Baholash` keyboard button → `web_app`; a `setChatMenuButton` set-on-interaction for teachers; honor the kill-switch.
- `src/pages/TeacherHomework.tsx:56` — junction-aware co-teacher fix.

---

## Task 1: `teacher_pending_submissions()` RPC + kill-switch row

**Files:**
- Create: `supabase/migrations/<next-ts>_teacher_pending_submissions.sql`

**Interfaces — Produces:**
- `public.teacher_pending_submissions()` returns setof rows: `submission_id uuid, user_id uuid, student_name text, group_id uuid, group_name text, module_number int, task_number int, assignment_id uuid, assignment_title text, max_score int, submitted_at timestamptz, previous_score int, is_resubmission bool, media jsonb, submitted_image_url text`. SECURITY DEFINER, `set search_path=public`, granted to `authenticated, service_role`. Scope = the CALLER's junction teacher groups (`teacher_group_ids(auth.uid())`); pending = `score is null OR score_is_stale`.
- `platform_settings` row key `teacher_miniapp` = `{"enabled": true}`.

**Steps:**
- [ ] **Step 1:** Read the bot's existing pending logic to mirror its filters exactly: `telegram-bot-webhook/index.ts` `gradingScopeIds` (~line 3355) and `loadGradingSubmissions` (~3367-3389) — copy the pending predicate (`score.is.null,score_is_stale.is.true`), the sap-aware `task_number`, and the assignment/profile joins. Also read `group_student_leaderboard` migration for the junction-scope idiom.
- [ ] **Step 2:** Write the migration. Body (adapt to real column names verified against `homework_submissions`/`homework_assignments`/`profiles`):

```sql
create or replace function public.teacher_pending_submissions()
returns table (
  submission_id uuid, user_id uuid, student_name text, group_id uuid, group_name text,
  module_number int, task_number int, assignment_id uuid, assignment_title text, max_score int,
  submitted_at timestamptz, previous_score int, is_resubmission boolean,
  media jsonb, submitted_image_url text
)
language sql stable security definer set search_path = public as $$
  select hs.id, hs.user_id,
         coalesce(p.name,'')||' '||coalesce(p.last_name,'')
           || case when p.telegram_username is not null then ' (@'||p.telegram_username||')' else '' end,
         p.group_id, g.name,
         ha.module_number, ha.task_number, ha.id, ha.title, coalesce(ha.max_score,10),
         hs.submitted_at, hs.previous_score, coalesce(hs.attempt_number,1) > 1,
         hs.media, hs.submitted_image_url
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id
  join homework_assignments ha on ha.id = hs.assignment_id
  where p.group_id in (select public.teacher_group_ids(auth.uid()))
    and (hs.score is null or hs.score_is_stale is true)
  order by hs.submitted_at asc;
$$;
revoke all on function public.teacher_pending_submissions() from public, anon;
grant execute on function public.teacher_pending_submissions() to authenticated, service_role;

insert into platform_settings (key, value)
values ('teacher_miniapp', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;
```

  VERIFY every referenced column exists (module_number/task_number may be on the assignment or need the sap-aware CASE the bot uses — replicate the bot's exact `task_number` derivation if SAP; see homework-sap-step-display memory). Do NOT invent columns.
- [ ] **Step 3 (verify):** Manually review for idempotency (`create or replace`, `on conflict do nothing`), SECURITY DEFINER + search_path, junction scope (`teacher_group_ids`), no anon leak (revoke from anon). Confirm newest timestamp. (Cannot execute — MCP is read-only; the migration-safety reviewer + the apply pipeline are the gates.)
- [ ] **Step 4:** Commit `supabase/migrations/<ts>_teacher_pending_submissions.sql`.

---

## Task 2: `hw-image-url` edge function (the C2 blocker)

**Files:**
- Create: `supabase/functions/hw-image-url/index.ts`
- Modify: `supabase/config.toml` (register the function; set `verify_jwt` per the pattern other authed fns use)

**Interfaces — Produces:** `POST hw-image-url { submission_id }` → `{ url }` (a viewable https URL) or `{ url: null, reason }`. Auth: the caller's Supabase JWT (teacher session); the function verifies the caller is a teacher of the submission's group (junction-aware) before returning a URL.

**Steps:**
- [ ] **Step 1:** Read `src/pages/Homework.tsx` (the `media` resolve effect ~L272 + the header comment) to learn the media shapes: storage entries (have `url` / `submitted_image_url` path in the private `homework_images` bucket) vs Telegram-only (`file_id`, `msg_url`, no http `url`). Read an existing internal-secret/authed edge fn for the boilerplate (`submit-homework/index.ts`).
- [ ] **Step 2:** Implement: (a) auth the caller from JWT → `auth.uid()`; load the submission + its group; reject with 403 if `is_group_teacher(group_id, uid)` is false (call the RPC or query `group_teachers`∪`groups`). (b) If the submission has a storage path (`submitted_image_url` or a `media[]` entry with a bucket path), return a **signed URL** (`createSignedUrl`, ~1h) from the `homework_images` bucket. (c) Else if a `media[]` entry has a Telegram `file_id`, call the bot API `getFile` → build `https://api.telegram.org/file/bot<token>/<file_path>`; return that (short-lived). NEVER log the token. (d) Else `{ url: null, reason: "no_viewable_media" }`.
- [ ] **Step 3 (verify):** `deno check supabase/functions/hw-image-url/index.ts` clean. Reason through: a storage-only submission → signed URL; a `file_id`-only submission → proxied URL; a non-teacher caller → 403; a co-teacher → allowed.
- [ ] **Step 4:** Commit the function + config.toml.

---

## Task 3: Role-aware landing + routes + BackButton root

**Files:**
- Modify: `supabase/functions/tg-miniapp-auth/index.ts` (target_path logic ~L77-85)
- Modify: `src/components/.../TelegramGate.tsx` (post-auth navigate ~L99-107)
- Modify: `src/App.tsx` (route registration)
- Modify: `src/lib/telegram/useTelegramBackButton.ts` (`ROOT_PATHS`)

**Interfaces — Produces:** opening the Mini App as a teacher/admin lands on `/tg/teacher`. `/tg/teacher` + `/tg/teacher/grade` routes exist, staff-guarded. `/tg/teacher` is a BackButton root.

**Steps:**
- [ ] **Step 1:** In `tg-miniapp-auth`, after resolving the profile's role, set `target_path`: if the caller has role teacher/admin/superadmin AND no explicit `start_param`/target already requests a student path → `/tg/teacher`; else keep existing behavior. Preserve student default `/dashboard`.
- [ ] **Step 2:** In `TelegramGate`, change the post-auth navigate so that if the app was opened directly at a path under `/tg/` (esp. `/tg/teacher*`), it does NOT `navigate(target_path,{replace})` over it — honor the requested path; only apply `target_path` when landing on the default root. (Read the current effect; the fix is: skip the forced redirect when `location.pathname.startsWith('/tg/')`.)
- [ ] **Step 3:** In `App.tsx`, register `<Route path="/tg/teacher" element={<RequireAuth staffOnly><TeacherHome/></RequireAuth>} />` and `/tg/teacher/grade` → `TeacherGrade`, wrapped by `TeacherShell` (Task 4). Use the existing staff guard (`RequireAuth staffOnly` — confirm the prop name). Ensure a student hitting `/tg/teacher` is bounced (guard handles it).
- [ ] **Step 4:** Add `"/tg/teacher"` to `ROOT_PATHS` in `useTelegramBackButton.ts` so the native BackButton is hidden on the teacher home.
- [ ] **Step 5 (verify):** `npm run typecheck` + `npm run build` clean; `deno check` on tg-miniapp-auth clean. Reason: teacher open → `/tg/teacher`, no clobber; student open → `/dashboard` unchanged; direct `/tg/teacher/grade` open survives the gate.
- [ ] **Step 6:** Commit the four files (stub `TeacherHome`/`TeacherGrade`/`TeacherShell` as minimal placeholders so it compiles; they're fleshed out next).

---

## Task 4: TeacherShell + TeacherBottomNav + usePendingGrading

**Files:**
- Create: `src/components/teacher/TeacherShell.tsx`, `src/components/teacher/TeacherBottomNav.tsx`, `src/hooks/usePendingGrading.ts`
- Reference: `src/components/StudentBottomNav.tsx`, `src/components/Layout.tsx` (`PageShell`), `src/lib/telegram/useTelegramViewport.ts`, `src/hooks/usePendingHomework.ts` (find the real name)

**Interfaces — Produces:** `<TeacherShell>{children}</TeacherShell>` renders a mobile page (max-w-2xl, safe-area padding, `overflow-x-hidden`, bottom padding reserve) with `TeacherBottomNav` (tabs: Bosh `/tg/teacher`, Baholash `/tg/teacher/grade`, Guruhlar `/tg/teacher/groups`, Statistika `/tg/teacher/stats` — the last two are Phase 2, render as disabled/"tez orada" for now). `usePendingGrading()` → `{ count, loading }` from `teacher_pending_submissions()` length (or a lighter count RPC — for Phase 1 reuse the list length, cached).

**Steps:**
- [ ] **Step 1:** Clone `StudentBottomNav` → `TeacherBottomNav`: same `fixed bottom-0`, `env(safe-area-inset-bottom)`, `grid grid-cols-4 h-14`, active-route styling. Tabs per above; show a coral count dot on Baholash from `usePendingGrading().count`. Guruhlar/Statistika tabs disabled with a subtle "tez orada" until Phase 2.
- [ ] **Step 2:** Write `usePendingGrading` mirroring the student pending hook: call `supabase.rpc("teacher_pending_submissions")`, return `.length` as count (Phase 1); handle loading/error → count 0.
- [ ] **Step 2b:** Write `TeacherShell`: consume `useTelegramViewport` vars (`--tg-viewport-stable-height`, safe-area), wrap children in `max-w-2xl mx-auto px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] overflow-x-hidden`, render `TeacherBottomNav` fixed at the bottom. Do NOT render the desktop `TopNav`/sidebar.
- [ ] **Step 3 (verify):** `npm run typecheck` + `build` clean. Visually reason: teacher routes now show the 4-tab bottom nav, no desktop chrome, safe-area respected.
- [ ] **Step 4:** Commit the three files.

---

## Task 5: Teacher Home `/tg/teacher`

**Files:**
- Modify: `src/pages/teacher/TeacherHome.tsx` (flesh out the Task 3 stub)
- Reference: `src/pages/Dashboard.tsx` (Hero + StatTile grid + EmptyState + onLine pattern), `src/components/ui-kit/*`

**Interfaces — Consumes:** `usePendingGrading()`, `teacher_group_ids`/`teacher_groups` for group context. **Produces:** the home screen.

**Steps:**
- [ ] **Step 1:** Layout per spec + design review: greeting (`Hero`), a 4-up `StatTile` row (Kutilmoqda / Bugun baholandi / Faol % / Guruhlar — "bugun" strip folded into tiles), the **single primary** = the Baholash hero CTA (→ `/tg/teacher/grade`), and a secondary action row for the Phase-2 tiles (disabled "tez orada"). Multi-group: Home aggregates across the teacher's junction scope (no per-group switcher on Home).
- [ ] **Step 2:** States: loading → `Skeleton`; error/offline → `navigator.onLine`-aware `EmptyState`+retry (copy the student pattern verbatim); **N=0 grading** → the hero becomes a calm `StatusChip kind="ok"` "Hammasi baholandi ✅" (not a coral CTA to an empty queue).
- [ ] **Step 3 (verify):** `typecheck` + `build` clean. Reason through all states.
- [ ] **Step 4:** Commit.

---

## Task 6: Grading screen `/tg/teacher/grade` (the centerpiece)

**Files:**
- Modify: `src/pages/teacher/TeacherGrade.tsx`
- Create: `src/components/teacher/GradePhoto.tsx`, `src/lib/teacherApi.ts`
- Reference: `src/pages/Homework.tsx` (image fallback + graded-detail layout), `TeacherHomework.tsx` (`saveScore`/return-for-redo logic to mirror), `ui-kit/*`

**Interfaces — Consumes:** `teacher_pending_submissions()`, `hw-image-url`. **Produces:** the swipe-through grading flow.

**Steps:**
- [ ] **Step 1:** `teacherApi.ts`: `fetchPendingQueue()` (rpc), `resolveImageUrl(submission_id)` (invoke `hw-image-url`), `submitScore(submission_id, score, feedback)` → update `homework_submissions` (`score`, `score_feedback`, `scored_by=auth.uid()`, `scored_at=now()`, clear `score_is_stale`) via the RLS-gated client (is_teacher_of junction-aware; XP triggers fire). `returnForRedo(submission_id)` mirroring `TeacherHomework.tsx`'s "🔓 return to student" (bump attempt/clear score per its exact logic — read it).
- [ ] **Step 2:** `GradePhoto.tsx`: fetch the resolved URL via `hw-image-url`; render with a loading `Skeleton` and a **degraded state** (C2) "rasmni ko'rib bo'lmadi — botda oching" with an open-in-Telegram link when `url` is null; tap → full-screen lightbox with pinch-zoom (overlay; reuse the CelebrationOverlay scaffold pattern for the portal).
- [ ] **Step 3:** `TeacherGrade.tsx`: one-at-a-time card. Header: `ProgressBar` + "3 / 12" (tabular-nums). Card: `GradePhoto`, student name + sap-aware "Modul 3 · Vazifa 1" (`truncate`), submitted-ago. **Score chips derived from `max_score`** (top band, e.g. for max 10 → [max, max-1, max-2, max-3] plus a "boshqa" free numeric entry ≤ max; a low/failing score is valid). Feedback: collapsible "Izoh qo'shish" `Textarea` (kept out of the default fold so the keyboard doesn't cover the photo/chips — size with `--tg-viewport-stable-height`). Primary = "Baholash → keyingi" (submits + auto-advances); "O'tkazib yuborish" = ghost; a "🔓 Qaytarish" action for redo.
- [ ] **Step 4:** Undo (G3): after a submit, show a Sonner `toast` with an "Ortga" action that restores that submission to the front of the queue and (best-effort) reverts the write if tapped within the window; otherwise it's committed.
- [ ] **Step 5:** States: loading (card `Skeleton`), empty/end-of-queue ("Baholash tugadi ✅" `EmptyState`), error/offline (retry), submit-in-flight (disable + spinner on the primary), submit-failed (toast, keep the score, don't advance), **already-graded-by-co-teacher** (on advance, if the next item was graded by someone else meanwhile → skip with a gentle "boshqa ustoz baholadi" per the member-forgiveness principle). Refresh the queue after N submits or on focus.
- [ ] **Step 6 (verify):** `typecheck` + `build` clean; `deno check` on any touched fn. Reason through: grade a storage-photo submission; grade a file_id-photo submission (resolver); a co-teacher grades; max_score=5 chips; low score; redo; undo; empty queue; offline mid-submit (score not lost).
- [ ] **Step 7:** Commit.

---

## Task 7: Entry wiring — Baholash web_app button + per-teacher menu button + kill-switch

**Files:**
- Modify: `supabase/functions/telegram-bot-webhook/index.ts` (`getTeacherKeyboard` ~1412; a `setChatMenuButton` call; kill-switch read)

**Interfaces — Consumes:** `platform_settings.teacher_miniapp.enabled`; `SITE_URL`. **Produces:** teachers reach the Mini App from the keyboard + the ☰ menu button.

**Steps:**
- [ ] **Step 1:** Read `getTeacherKeyboard` + how `web_app` buttons are built elsewhere (the admin `/tg/broadcast` button ~1402, and the digest board button). Confirm `SITE_URL` + https domain.
- [ ] **Step 2:** When the kill-switch is enabled: change the `📝 Baholash` teacher-keyboard button to a `web_app` button → `${SITE_URL}/tg/teacher/grade`. When disabled: leave it as the current bot command (fallback). Keep callback/text ≤64B (a web_app button carries a URL, not callback_data — fine).
- [ ] **Step 3:** On a teacher's bot interaction (cheap, idempotent), set their menu button: `setChatMenuButton({ chat_id, menu_button: { type: "web_app", text: "📝 Ustoz", web_app: { url: `${SITE_URL}/tg/teacher` } } })` when enabled; when the kill-switch is off, reset to default. Gate on role=teacher/admin only (never students). Do it best-effort (never block the handler).
- [ ] **Step 4 (verify):** `deno check` clean. Reason: enabled → Baholash opens the Mini App + ☰ set for teachers; disabled → reverts to bot command + default menu; students unaffected.
- [ ] **Step 5:** Commit.

---

## Task 8: `/teacher/homework` co-teacher fix

**Files:**
- Modify: `src/pages/TeacherHomework.tsx:56` (the `teacher_id`-only filter)

**Steps:**
- [ ] **Step 1:** Read `TeacherHomework.tsx` around L56 — it filters groups/students by `groups.teacher_id === me`. Change the scope to junction-aware: fetch the teacher's group ids via `teacher_group_ids` RPC (or `groups.teacher_id == me` ∪ `group_teachers` where `teacher_id == me`) and filter by `group_id in (those)`. Mirror the pattern used by the bot's `teacherGroups` / the co-teacher modal.
- [ ] **Step 2 (verify):** `typecheck` + `build` clean. Reason: a pure co-teacher now sees their group's pending homework here (was empty).
- [ ] **Step 3:** Commit.

---

## Verification (whole Phase 1, on prod after merge)

E2E with synthetic users (create via `admin-create-students` + a group + a co-teacher via the Edit-group modal; submit a homework as a synthetic student — one storage-photo, one bot `file_id` photo if reachable):
- Teacher opens Mini App → lands on `/tg/teacher` (not desktop admin); bottom nav shows.
- Grading queue lists the pending submission with the right label + max_score.
- Photo renders (both media kinds); grade + feedback writes; score + XP settle (xp_events ref-keyed, no double-award); the row leaves the queue.
- A **co-teacher** sees + grades the same queue.
- Kill-switch off → Baholash reverts to the bot command; students never see `/tg/teacher`.
- Delete synthetics → zero residue.

---

## Self-review (done at write time)
- **Spec coverage:** shell (T4) / routing+auth+BackButton (T3) / grading incl. RPC (T1) + resolver (T2) + card+states (T6) / entry wiring (T7) / co-teacher `/teacher/homework` fix (T8) / kill-switch (T1+T7) — all Phase-1 spec items mapped. Phase 2/3 screens intentionally excluded.
- **Placeholder scan:** the two Phase-2 nav tabs render "tez orada" (explicit), not a TODO. Column names in the RPC (T1) are flagged "VERIFY against real schema" because the plan can't run SQL — the implementer must confirm before finalizing; this is a real instruction, not a placeholder.
- **Type consistency:** the RPC's returned fields (T1) are the columns `teacherApi.fetchPendingQueue` (T6) + the grading card consume; `resolveImageUrl`/`submitScore`/`returnForRedo` names are used consistently T6↔UI.
