# Tiered Course Access — Architecture Assessment & Build Spec
_web-architect skill · 2026-06-13_

## Verdict

**Do NOT duplicate the course. Use one course (8 modules) + a per-enrollment access limit.**
Duplication fragments stats/leaderboard/groups, breaks the 5→8 upgrade path (loses progress),
and forces a full copy for every future tier. The entitlement model makes an upgrade a one-field
update and makes every future course/tier free.

The non-obvious senior decisions (where the rigor changed the plan):

1. **Enforce at the value-bearing endpoints, NOT via broad RLS on `modules`/`lessons`.**
   A 5-module student *seeing* a locked Module 6 title + upsell is fine and standard. What must be
   server-protected is the **video URL, the progress write, and homework submission**. Adding
   tier-RLS to `lessons`/`modules` (today `USING(true)`) is the single highest-blast-radius option
   — it would silently alter dozens of read paths (leaderboard, certificates, badges, teacher/admin
   views, analytics). We gate the three write/serve endpoints server-side (real security) and filter
   the listing surfaces at the application layer (UX). Lower risk, same protection.

2. **Golden-baseline guarantee (the change-safety key): `module_limit IS NULL` = full = today's
   behavior, byte-identical.** Every tier-aware filter treats NULL as "no limit," so all ~500
   existing students and every current calculation are UNCHANGED. Risk is isolated to the new
   5-module cohort. This de-risks the whole change.

## Data model

```sql
ALTER TABLE public.enrollments ADD COLUMN module_limit int;           -- NULL = full access (8); 5 = modules.position <= 5
ALTER TABLE public.enrollments ADD CONSTRAINT chk_module_limit CHECK (module_limit IS NULL OR module_limit >= 1);
ALTER TABLE public.groups      ADD COLUMN default_module_limit int;   -- bulk-assign convenience; new members inherit
CREATE INDEX idx_enrollments_user_course ON public.enrollments(user_id, course_id);
```
- **On `enrollments`** (not `profiles`): tier is per-course; enrollments is the natural join point; RLS already flows through it; future courses need no schema change.
- **Count, not a module-set**: tiers are contiguous prefixes ("first 5"). A junction table (`enrollment_modules`) is only needed for cherry-picked access — YAGNI now, migratable later.
- **`groups.default_module_limit`**: students are organized into tier cohorts; set it once on the group, members inherit at creation/import. Keeps the group leaderboard fair (homogeneous tier).

Reusable gate (mirrors the existing `has_role` pattern):
```sql
CREATE OR REPLACE FUNCTION public.has_module_access(_user_id uuid, _module_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    public.has_role(_user_id,'admin'::app_role)
    OR public.has_role(_user_id,'superadmin'::app_role)
    OR public.has_role(_user_id,'teacher'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.modules m
      JOIN public.enrollments e ON e.course_id = m.course_id AND e.user_id = _user_id
      WHERE m.id = _module_id AND m.position <= COALESCE(e.module_limit, 2147483647)
    );
$$;
```

## OWASP security pass — Broken Access Control (#1) / IDOR

Today `lesson-video-url` checks **auth only** — any logged-in user can fetch any lesson's signed
video by passing the `lessonId`. That's a live IDOR even before tiering. Three server-side gates
(the only real enforcement; everything else is UX):

| # | Endpoint | Current | Gate (server-enforced) |
|---|---|---|---|
| S1 | `lesson-video-url` | auth only | resolve lesson→module.position; `403` if `> module_limit` (call `has_module_access`) |
| S2 | `track_video_progress` RPC | auth only | same check before recording progress (don't record locked lessons) |
| S3 | bot homework submit + `/vazifalar` + intent start | none | reject/hide assignments whose `module.position > module_limit` |

## Change-safety / regression — crown jewels

These currently assume "whole course = all 8 modules" and **break or demotivate 5-module students**.
Each fix is a no-op when `module_limit IS NULL` (8-module students unaffected — verify by diff).

| # | Crown jewel | File:line | Breaks for 5-mod student | Tier-aware fix |
|---|---|---|---|---|
| C1 | Certificate eligibility | `20260503054526_*:82-100` | 100% of 5 modules but `done(5) < total(8)` → **never** issued | count total/done over `position <= limit` |
| C2 | `course_complete` badge | `20260502232838_*:157-163` | never reaches all-8 total → badge locked forever | same accessible-module count |
| C3 | Progress % / "X/8" — bot `/galaba` | `telegram-bot-webhook:1301-1352` | shows "5/8 = 50%" forever though 100% done | `totalLessons` over accessible modules |
| C4 | Progress / forecast — web | `StudentAnalytics.tsx:109-240` | "finish by July 15" mathematically impossible | filter modules by `position <= limit` |
| C5 | Homework totals | `homework-stats.ts:85-102` + bot leaf calc | 48/80 = 6/10 instead of 48/50 = 9.6/10 → penalized | filter leaves to accessible modules |
| C6 | `getNextIncompleteLesson` (re-engagement deep links) | `cron-engagement:117-133` | reminder deep-links into locked Module 6 | filter to accessible modules |
| C7 | Daily goal (`weekly_goal_lessons/7`) | `telegram-bot-webhook:1367` | goal calibrated to 8 modules, off for tier-5 | tier/accessible-aware default |
| C8 | Teacher grading view | bot homework view | teacher sees module-6 homework a tier-5 student can't submit | filter teacher view to student's accessible modules |

**Safe / unchanged (do not touch):** streak (activity-based, module-agnostic), lesson-count badges
(first/5/10), homework effective-grade *formula*, group leaderboard window, serial/PDF cert format.

### Leaderboard fairness — one decision (not auto-fixed)
The 30-day score normalizes `lessons_30d` by a global max, so a tier-5 student maxes lower than a
tier-8 student at equal effort. **Mitigated** because the primary social surface (`/galaba`) is the
**group** leaderboard and groups are tier-homogeneous. Options for the global top-10:
- (a) Accept it (8-module students do more content) — zero change.
- (b) Normalize the lessons component by the student's **accessible** lesson count (score = % of
  *your* content) — fairest, but a `recalc_leaderboard` change (higher blast radius; behind the
  golden-baseline NULL guard it's safe for tier-8).
Recommendation: ship (a) for launch, revisit (b) if tier-5 students complain.

## Assignment & upgrade
- **Assign:** set `groups.default_module_limit`; bulk-import (`admin-create-students`) and new members
  inherit it. Single-student override = a tier dropdown on the AdminUsers enrollment dialog.
- **Upgrade 5→8:** `UPDATE enrollments SET module_limit = 8 WHERE user_id=? AND course_id=?` + audit
  row. All progress/streak/homework/leaderboard carry over instantly. A `bulk_upgrade_enrollments(uids,…)`
  admin RPC covers cohort upgrades.
- **No payment integration exists** in the repo (confirmed). Tier is set by admin today; a future
  payment webhook just calls the same UPDATE — no schema change.

---

```
# BUILD SPEC: Tiered course access (5 vs 8 modules)

## Objective
One course, two access tiers gated by enrollments.module_limit (NULL=full). Server-enforce the
paid content; make stats/recognition tier-aware; keep all current (8-module) behavior identical.

## Context
- Stack: React+TS+Vite+Tailwind + Supabase (Postgres + Deno edge fns) + Telegram bot. Existing live system, ~500 students.
- Decisions made: entitlement on enrollments (count), enforce at value endpoints (not broad RLS),
  groups carry a default tier, NULL=full=golden baseline.

## Requirements
1. enrollments.module_limit + groups.default_module_limit + has_module_access() helper.
2. Server gates: lesson-video-url, track_video_progress, bot homework (submit/list/intent) → deny module.position > limit.
3. Tier-aware crown jewels C1–C8 (certificate, course_complete badge, progress%/totals web+bot, homework totals, getNextIncompleteLesson, daily goal, teacher view).
4. UI: CoursePage/LessonPage/Dashboard show locked modules with an upgrade upsell; block locked lesson render.
5. Admin: tier dropdown on enrollment + bulk_upgrade_enrollments RPC + group default + CSV column; handle_new_user honors group default.
The 3 most important: (2) server gates [security], (1) the entitlement+helper [foundation], (3) C1/C2/C3/C5 [or tier-5 students are silently broken].

## Scope & non-goals
- In scope: the files named in C1–C8 + the 3 server endpoints + AdminUsers/GroupDetail + migration.
- Off-limits: streak functions, badge award engine (except the course_complete count), leaderboard recalc (unless option (b) chosen), the homework effective-grade formula, anything unrelated.
- Non-goals: no broad RLS on lessons/modules; no new payment integration; no junction table; no refactors.

## Data & API
- Migration: the ALTERs above + has_module_access() + bulk_upgrade_enrollments() (admin-gated, audited).
- API: edge fns S1/S2 add a has_module_access check → 403 {error:"module_locked"}. Bot filters lists by accessible modules. FE reads enrollments.module_limit to gate UI.

## Build plan (sequential; confirm plan before coding)
1. Migration (columns + helper + bulk RPC) — additive, applied via Lovable. Backfill: existing enrollments stay NULL (full).
2. Server gates S1/S2/S3.
3. Crown-jewel tier-awareness C1–C8 (each guarded so NULL = current behavior).
4. UI gating + upsell.
5. Admin assignment + upgrade + CSV + handle_new_user.

## Security (OWASP)
Access control: server-enforced module gate at S1/S2/S3 via has_module_access (no client trust).
Input validation: parameterized (Supabase client / SQL functions). Secrets: unchanged. Logging:
upgrades + denials → admin_actions. RLS: enrollments/admin RPCs admin-gated; lessons/modules RLS unchanged.

## Regression — do NOT break existing
Golden baseline = every 8-module (module_limit NULL) student and all current calcs produce IDENTICAL
output. For each of C1–C8: run with limit NULL and diff against pre-change output (certificate issues,
badge awards, "/galaba" totals, leaderboard score, homework avg10, getNextIncompleteLesson, daily goal).
A NEW 5-module test student must: see only modules 1–5, be 403'd on a module-6 video/progress/homework,
hit 100% progress + certificate + course_complete at 5 modules, and get a fair homework avg.

## Acceptance criteria + verification
- S1/S2: authenticated tier-5 user requests a module-6 lesson → 403 (curl/SQL net.http_post test).
- C1/C2: tier-5 test student completes 5 modules → certificate row issued + course_complete badge (SQL check).
- C3/C4: bot /galaba + web dashboard show 100% for a finished tier-5 student (screenshot/string check).
- C5: homework avg10 for tier-5 computed over 5 modules only (SQL vs expected).
- Regression: NULL-limit diff on all C1–C8 = no change.

## Deploy notes
Migration + bot/edge via Lovable; FE via push + Lovable Publish. Set groups.default_module_limit before
importing each cohort. Log all tier changes to admin_actions.
```

## Self-check (web-architect "done" bar)
- Spec executable without further input: **yes** (file:line fixes enumerated). 
- OWASP addressed: **yes** — access control is the centerpiece (S1–S3).
- Deliberate design (not template): **yes** — entitlement over duplication, app-layer over broad RLS, justified.
- Every requirement verifiable: **yes** (curl/SQL/screenshot per item).
- Change-safety ran: **yes** — crown jewels inventoried, golden baseline = NULL no-op, diff plan defined.

**Weakest spots (flagged honestly):** (1) leaderboard cross-tier fairness is deferred, not solved
(option b if needed). (2) Default tier for self-signups depends on your funnel — needs your input.
(3) The bot file is 4,500 lines; the C3/C5/S3/C8 edits there need careful regression on the existing
`/galaba` + homework flows.
