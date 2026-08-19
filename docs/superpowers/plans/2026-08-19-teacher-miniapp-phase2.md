# Teacher Mini App — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This repo has **no frontend unit-test harness**; the verification bar is `npm run typecheck` (tsc — the real gate) + `npm run build`, and prod E2E. Task "verify" steps use those.

**Goal:** Add the teacher Mini App's **Groups & students** and **Stats** screens (Phase 1 shipped the shell + grading), so a teacher/co-teacher can browse their groups → student roster → a student's progress + homework history, and see per-group stats + leaderboards — all on mobile.

**Architecture:** Frontend-only, on the Phase 1 session gate + `TeacherShell`. Reuses existing **junction-aware** RPCs (co-teachers already work): `teacher_groups`, `staff_group_members`, `staff_group_overview`, `group_student_leaderboard`. Wires the two "tez orada" bottom-nav tabs (Guruhlar, Statistika) live, adds a shared selected-group context across tabs, and re-skins the existing `TgGroupBoard` data into the in-session Stats screen with the ui-kit. A single-student homework-history read is the only possibly-new backend (RLS query first; a tiny RPC only if RLS is insufficient).

**Tech Stack:** React 18 + Vite + TS + React Router, Tailwind + `ui-kit`, Supabase RLS/RPCs, Telegram WebApp SDK.

**Spec:** `docs/superpowers/specs/2026-08-18-teacher-miniapp-design.md` (Phase 2 = Groups & students + Stats; read the "Review findings folded in" + "Phasing" sections).

## Global Constraints

- **Branch:** `feat/teacher-miniapp-phase2` off current `main` (which has Phase 1 #88 + incident #89). Never merge to `main` without the owner's explicit "merge it".
- **Never `git add -A`** (chronically dirty `.env`/`deno.lock`/`scripts/`) — stage explicit paths.
- **Junction-aware everywhere:** all reads must admit co-teachers. Use only the confirmed junction-aware RPCs below; do NOT filter `groups.teacher_id` directly. `.rpc("name" as any, …)` cast where generated types lack the RPC (frontend-typecheck-verify convention).
- **Design:** dark-only, mobile-first, `max-w-2xl`, EXACTLY ONE `Button variant="primary"` (`bg-cta`) per screen, ui-kit components by name (no old `ui/*`), `truncate`/`min-w-0` (no horizontal scroll), Telegram safe-area (the shell already handles it). Renders inside `TeacherShell` — screens are content-only, no shell/nav chrome.
- **States on every screen:** loading (`Skeleton`), empty (`EmptyState`), error/offline (`navigator.onLine`-aware `EmptyState` + retry) — copy the student-app pattern (`Dashboard.tsx`).
- **Staff-only:** routes are `RequireAuth staffOnly` (already the pattern in `App.tsx` for `/tg/teacher/*`).
- **No migration expected.** If Task 2 genuinely needs a new RPC, it's the only migration and needs the `migration-approved` label; prefer an RLS query.

## Confirmed junction-aware RPCs (verified live)
- `teacher_groups(uid uuid)` — the caller's groups (primary ∪ co-teacher).
- `staff_group_members(_group_id uuid)` — a group's student roster.
- `staff_group_overview(_group_id uuid)` — a group's summary stats.
- `group_student_leaderboard(_group_id uuid, _limit int)` — the board (weekly + all-time).
- `get_visible_student_ids(_scope_user_id uuid)` — the caller's visible students (for RLS-scoped reads).
Each implementer MUST read the RPC's real return columns (grep its defining migration) before building against it — do NOT assume field names.

---

## Task 1: Groups list + roster + shared group context (`/tg/teacher/groups`)

**Files:**
- Modify: `src/pages/teacher/TeacherGrade.tsx` is NOT touched. Create `src/pages/teacher/TeacherGroups.tsx` (currently the route is a "tez orada" nav stub — wire it).
- Create: `src/pages/teacher/TeacherRoster.tsx` (a group's roster) OR render roster inline in TeacherGroups behind a selected-group state — implementer's call; keep files focused.
- Create: `src/contexts/TeacherGroupContext.tsx` (or `src/hooks/useSelectedGroup.ts`) — the shared selected-group, persisted (localStorage or context) so Grading/Groups/Stats agree.
- Modify: `src/App.tsx` — register `/tg/teacher/groups` (staff-guarded, in `TeacherShell`).
- Modify: `src/components/teacher/TeacherBottomNav.tsx` — make the **Guruhlar** tab live (remove its "tez orada" disabled state; route to `/tg/teacher/groups`).

**Interfaces — Produces:** `useSelectedGroup()` → `{ groupId, setGroupId, groups }` (groups from `teacher_groups`); consumed by Task 3 (Stats) + optionally Grading's group filter.

- [ ] **Step 1:** Read `teacher_groups` + `staff_group_overview` + `staff_group_members` defining migrations (grep) for their exact return columns. Read `TeacherHome.tsx` (Phase 1) for the ui-kit patterns + the `navigator.onLine` states; read `TeacherBottomNav.tsx` for how the "tez orada" tabs are currently disabled.
- [ ] **Step 2:** Build `useSelectedGroup` (context or hook): loads `teacher_groups(user.id)`; holds a `groupId` (default the first group or the persisted one); `setGroupId` persists to localStorage keyed by user. Never throws (error → empty groups).
- [ ] **Step 3:** Build `TeacherGroups.tsx`: list the teacher's groups (each a `Card`/`SectionHeader` row with name + student count + pending count + completion %, from `staff_group_overview` per group or a batched read). Tap a group → the roster (`staff_group_members`): each student a row (name, progress %, last active, XP, pending) → tap → `/tg/teacher/groups/student/:studentId` (Task 2). The single coral primary, if any, is a minor accent; a pure list may have none — that's allowed for a list screen.
- [ ] **Step 4:** States: `Skeleton` loading; `EmptyState` for no groups ("Sizda guruh yo'q") and a group with no students; `navigator.onLine` error+retry. `truncate` long names.
- [ ] **Step 5:** Wire `App.tsx` route + the live Guruhlar nav tab.
- [ ] **Step 6 (verify):** `npm run typecheck` + `npm run build` clean. Reason: a co-teacher sees their junction groups + rosters; primary teacher unchanged; all states render. Commit (explicit paths).

---

## Task 2: Student detail (`/tg/teacher/groups/student/:studentId`)

**Files:**
- Create: `src/pages/teacher/TeacherStudentDetail.tsx`
- Modify: `src/App.tsx` — register the route (staff-guarded, in `TeacherShell`).
- Reference: `src/pages/Homework.tsx` (the graded-detail layout — reuse the score/`XpPill`/feedback presentation so teacher + student see the same artifact); `src/pages/admin/AdminStudentDetail.tsx` (how the admin view reads a student's homework — mirror its query, but scoped to the teacher's junction visibility).

**Interfaces — Consumes:** the `:studentId` route param; the teacher's junction visibility.

- [ ] **Step 1:** Determine the homework-history read. FIRST try an **RLS query**: as the authenticated teacher, `supabase.from("homework_submissions").select(...).eq("user_id", studentId)` — this is allowed IFF the teacher can see that student (RLS `hws own select` → `is_teacher_of`, junction-aware since #86). Verify by reading the `hws own select` policy. If RLS returns the rows for a co-teacher's student → use it (no new backend). Only if RLS is insufficient, add a minimal SECURITY DEFINER RPC `teacher_student_homework(_student_id uuid)` scoped to `get_visible_student_ids(auth.uid())` — that becomes the plan's single migration (needs `migration-approved`).
- [ ] **Step 2:** Also read the student's basics (name, group, progress %, XP, streak) — reuse what `staff_group_members` already returned (pass via nav state or re-query the student's profile/`lesson_progress` within visibility).
- [ ] **Step 3:** Build the screen: header (name + group), a progress/XP/streak `StatTile` strip, and a homework-history list (each: module/task label, score `X/max` + `StatusChip` (ok/redo/none), feedback, submitted-ago) reusing the `Homework.tsx` graded-detail presentation. A "Nudge" action is Phase 3 — omit or leave a disabled "tez orada".
- [ ] **Step 4:** States: loading `Skeleton`; empty ("Hali vazifa topshirmagan"); error/offline retry. `truncate`.
- [ ] **Step 5 (verify):** `typecheck` + `build` clean (+ `deno check` if an RPC/migration was added). Reason: a co-teacher opening a student in their junction group sees that student's homework history; a student NOT in the teacher's scope returns empty/denied (RLS). Commit.

---

## Task 3: Stats screen (`/tg/teacher/stats`) — re-skin the group board in-session

**Files:**
- Create: `src/pages/teacher/TeacherStats.tsx`
- Modify: `src/App.tsx` — register `/tg/teacher/stats` (staff-guarded, in `TeacherShell`).
- Modify: `src/components/teacher/TeacherBottomNav.tsx` — make the **Statistika** tab live.
- Reference: `src/pages/TgGroupBoard.tsx` (the existing initData board — reuse its data shape + leaderboard rendering, but call the RPCs from the authenticated session and restyle to ui-kit; the board uses bespoke `StatChip`/raw `select`/`rounded-2xl` — migrate to `StatTile` + a segmented control like `Homework.tsx:530`).

**Interfaces — Consumes:** `useSelectedGroup()` (Task 1) for the active group; `group_student_leaderboard(groupId, 50)` + `staff_group_overview(groupId)`.

- [ ] **Step 1:** Read `TgGroupBoard.tsx` + `group_student_leaderboard`/`staff_group_overview` return columns. Note the leaderboard is junction-aware and returns weekly + all-time (per the Phase-1 xp-integrity review).
- [ ] **Step 2:** Build `TeacherStats.tsx`: a group switcher (from `useSelectedGroup` — reuse the shared context so picking a group here also sets it for Grading/Groups); a summary `StatTile` strip from `staff_group_overview` (active/total, completion %, avg score, pending); the weekly + all-time student leaderboards from `group_student_leaderboard` (names + XP, `tabular-nums`, top-N). Segmented control to toggle weekly/all-time. The single coral primary is optional (a stats screen may have none).
- [ ] **Step 3:** States: `Skeleton` loading; `EmptyState` no-groups / no-data ("Hali ma'lumot yo'q"); error/offline retry. No horizontal scroll (leaderboard rows `truncate`).
- [ ] **Step 4:** Wire `App.tsx` route + the live Statistika nav tab. Confirm the shared group context persists: picking group B on Stats shows B on Groups and (if wired) Grading's filter.
- [ ] **Step 5 (verify):** `typecheck` + `build` clean. Reason: a co-teacher sees their group's board; group switch persists across tabs; leaderboard math is the existing RPC (untouched — no XP surface here). Commit.

---

## Verification (whole Phase 2, on prod after merge)
E2E with the real teachers (Guli/Feruza/Rano) or a synthetic co-teacher: open `/tg/teacher/groups` → see groups → a roster → a student's homework history; open `/tg/teacher/stats` → see the group board + leaderboards; confirm a **co-teacher** (e.g. Rano on 1-GURUH PRE) sees that group's roster/stats; confirm the group switch persists across tabs; no XP/data mutation (these are read screens).

## Self-review (done at write time)
- **Spec coverage:** Groups & students (T1 roster + T2 detail) / Stats (T3 board) / bottom-nav tabs live (T1+T3) / shared group context (T1, used T3) — all Phase-2 spec items mapped. Broadcast + nudge are Phase 3 (out of scope; nudge action stubbed "tez orada").
- **Placeholder scan:** the homework-history read (T2) is a real decision (RLS-first, RPC only if needed) with the exact policy to check — not a TODO. "tez orada" stubs are explicit deferrals.
- **Type consistency:** `useSelectedGroup()` shape `{ groupId, setGroupId, groups }` is produced in T1 and consumed in T3; the RPCs are called with the confirmed signatures; each task re-verifies real return columns before use.
