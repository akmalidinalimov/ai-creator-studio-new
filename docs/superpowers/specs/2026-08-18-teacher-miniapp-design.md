# Teacher-side Telegram Mini App — Design

**Status:** approved in brainstorming 2026-08-18 (owner). Ready for implementation plan.

**Goal:** Give teachers a real mobile Mini App — grading-first — inside Telegram, replacing the
current state where a teacher who opens the app is dumped on the desktop `/admin/dashboard` and every
teacher action (grade, students, stats, broadcast, nudge) lives only in bot-chat buttons.

**Owner decisions (locked):**
- **Full teacher Mini App** (not just an entry fix or a single bug).
- **Grading is the centerpiece** — the Mini App is the primary place teachers grade (bot-chat grading
  stays as a fallback).
- **v1 screens:** grading + groups & students + stats/board + broadcast + nudge (all of them).
- **Entry: both** — the `📝 Baholash` keyboard button becomes a `web_app` button, AND each teacher's
  ☰ menu button opens the Mini App.
- **Approach 1** — build on the existing full-app session gate (reuse RLS + junction-aware RPCs + the
  Graphite & Emerald ui-kit), not dedicated initData `/tg/*` pages.

## Architecture

Build on `TelegramGate` (`src/App.tsx`) → `tg-miniapp-auth` mints a real Supabase session on Telegram
open. New **session-gated, staff-guarded** mobile routes under `/tg/teacher`:

| Route | Screen |
|---|---|
| `/tg/teacher` | Home (grading hero + tiles + today strip) |
| `/tg/teacher/grade` | Grading queue (swipe-through) — the centerpiece |
| `/tg/teacher/groups` | Groups → roster → student detail |
| `/tg/teacher/stats` | In-app group board (stats + leaderboards) |
| `/tg/teacher/broadcast` | Send a message to a group |
| `/tg/teacher/nudges` | Inactive students → nudge |

- **Layout:** mobile-first, dark (matches the student Mini App polish), Graphite & Emerald `ui-kit`,
  persistent bottom nav (4 tabs: Home / Baholash / Guruhlar / Statistika); broadcast + nudge are
  actions reached from Home tiles and from within Groups.
- **Guard:** `RequireAuth` staff-only; teachers **and** admins may view. Co-teachers are included
  automatically — they carry the `teacher` role and every read below is junction-aware
  (`groups.teacher_id` ∪ `group_teachers`, shipped in #86).

### Routing fixes (foundational)
1. **Role-aware landing:** `tg-miniapp-auth` returns `target_path = /tg/teacher` for staff (teacher/
   admin) instead of `/dashboard`. So a teacher opening the Mini App lands on the teacher home, not the
   desktop admin panel.
2. **Gate-vs-`/tg` conflict:** `TelegramGate`'s post-auth `navigate(target_path, {replace})` can replace
   a `/tg/*` page mid-render (recon flag #3). Fix so that when the app is opened directly at a
   `/tg/teacher/*` path (deep-link / menu button), the gate mints the session but honors that path
   rather than clobbering it with the default target.
3. **Keep `/tg/group-board`** untouched for the 9 PM digest's "screenshot into the group chat" use; the
   Mini App's own `/tg/teacher/stats` renders the same data inside the authenticated session.

## Screens

### Home `/tg/teacher`
Greeting + primary group context. Hero CTA = **Baholash (N kutmoqda)** (pending count). Tiles:
Guruhlarim, Statistika, Xabar (broadcast), Nudge (M). A "bugun" strip (graded today, % active).

### Grading `/tg/teacher/grade` (centerpiece)
Swipe-through queue of the teacher's **pending** submissions (junction-aware scope), optional group
filter. Each card: homework photo (tap → full-screen), student name + @username, module/task label
("Modul 3 · Vazifa 1"), submitted-ago. Input: quick score chips (7/8/9/10) + free entry up to the
assignment `max_score`, optional feedback text. **Baholash → keyingi** submits and auto-advances;
**O'tkazib yuborish** skips. Resubmissions show the previous score. Score write = update
`homework_submissions` via RLS (`is_teacher_of`, junction-aware) → the +15/+25 XP triggers fire exactly
as in the bot flow. Empty state when the queue is clear.

### Groups & students `/tg/teacher/groups`
The teacher's groups (junction-aware) — each with student count, pending count, completion %. Tap a
group → roster (name, progress %, last active, XP, pending). Tap a student → detail: progress, homework
history with scores, XP, streak; actions: Nudge (and later, message).

### Stats `/tg/teacher/stats`
In-app group board: per-group active/total, completion %, avg score, pending; weekly + all-time student
leaderboards (`group_student_leaderboard`, junction-aware). Group switcher when several.

### Broadcast `/tg/teacher/broadcast`
Pick group → compose → send to the group's Telegram chat via the existing bot broadcast path. Confirm +
success/failure toast.

### Nudge `/tg/teacher/nudges`
List of students gone quiet (inactive N days) in the teacher's scope → tap → send the nudge DM via the
existing `teacher-nudge-student` function.

## Data & writes

**Reads (already junction-aware):** grading queue = teacher's pending submissions in junction scope;
roster = `teacher_groups` + members; stats = `admin_course_group_stats` + `group_student_leaderboard`;
nudges = inactive students in scope.

**Writes (reuse secured paths — no new scoring logic):** grade → RLS-gated submission update (XP
triggers auto-fire); broadcast → existing bot broadcast-to-group; nudge → `teacher-nudge-student`.

**Backend touch-ups (the only server work):**
1. Role-aware `target_path` in `tg-miniapp-auth` (staff → `/tg/teacher`).
2. A junction-aware **pending-submissions LIST** read for the grading queue (the bot uses
   `gradingScopeIds` + a query; expose an equivalent RPC/read the Mini App can call).
3. Entry wiring: `📝 Baholash` keyboard button → `web_app`; set each teacher's ☰ menu button via
   `setChatMenuButton` (one-time sweep + on teacher creation, mirroring `refresh-teacher-keyboards`).
4. **Bonus fix:** make the old `/teacher/homework` web page junction-aware (`TeacherHomework.tsx:56`
   filters `teacher_id` only, so a pure co-teacher currently sees nothing there).

## Safety, rollout, verification

- **Staff-only:** students never see the teacher Mini App (no student entry point is wired; this only
  adds teacher/admin entry).
- **Kill-switch:** a `platform_settings` flag disables the Mini App entry (keyboard `web_app` reverts to
  the bot command; menu button cleared) instantly.
- **Idempotency:** grade writes stay XP-safe (xp_events ref-keyed); no double-award.
- **Health signal (doctrine):** Mini-App grades are DB-visible / source-tagged so the watchdog layer
  sees them; a failed grade write emits a DB-visible signal, not just a console error.
- **Non-regression:** the bot-chat teacher flows, the digest board, and student Mini App are untouched.
- **E2E verification (prod, synthetic):** create a synthetic teacher + co-teacher + student + a
  submission; grade from the Mini App; confirm score + XP settle; confirm the **co-teacher** can grade
  the same queue; confirm the primary-only path unchanged; delete synthetics (zero residue).

## Explicitly out of scope for v1
- Admin Mini App (separate effort).
- Surfacing the Mini App to students (still staff-only).
- Teacher→student direct chat/messaging beyond the existing nudge + broadcast.
- Offline/PWA behaviors beyond what the student Mini App already has.

## Known risks
- The `TelegramGate` ↔ `/tg` redirect conflict must be fixed carefully (verify on a real teacher open).
- `setChatMenuButton` is per-user; the sweep must be maintained as teachers are added (and cleared by
  the kill-switch).
- Photo delivery on mobile: homework images are private-bucket; the Mini App must fetch them via the
  same signed-URL/RLS path the grading flow uses (co-teachers must be able to view — storage RLS is
  junction-aware since #86).
