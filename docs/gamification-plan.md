# Student Gamification — Plan & Handoff

Status: **NOT started.** Needs brainstorm → spec → plan before building.
Date: 2026-06-09

## Deploy reality (important)
Lovable owns DB migrations + edge-function + Telegram-bot deploys. A direct `git push` only deploys the frontend (Vercel). To change the DB / edge functions / bot, instruct Lovable (or use its SQL editor). Edge/bot changes land back in this repo via Lovable's own commits.

## Where the student experience stands (observed live)
Bot data is correct (rating/grades verified against the DB). The UX is bare: the student **📊 Statistikam** screen is 7 dense text lines (Lessons, Streak, Daily goal, Homework, Points, Rank, Badges) — all numbers right, zero visuals.

## Top 10 improvements (prioritized)

**Quick wins — pure formatting of data we already have**
1. Visual **progress bars** in stats (`██████░░░░ 25%`) instead of bare `13/52`.
2. **Badge showcase** — list earned + the NEXT locked badge and its unlock condition (not just `4/8`).
3. **Richer homework cards** — task name + colored status + the teacher's comment inline (today: a wall of `0/10` with no feedback).
4. Fix **"Ball: X/70" denominator** confusion (points earned counts scored tasks but is shown over all tasks; reconcile with the grade-average basis or relabel).
5. **Helpful fallback** on unrecognized text input (today: silence) → show the keyboard hint.

**High-impact additions**
6. **Mini-leaderboard view** in the bot ("you're #264 — 2 points behind #263; watch 1 lesson to pass them"). Strongest retention lever; today students only see their own rank number.
7. **Streak protection nudges** (evening "your streak ends in Xh") + streak milestone badges (3/7/30).
8. **Levels / XP** mapped from the activity score (friendlier than "11/100").

**Navigation / onboarding**
9. Keep students **in Telegram** where possible (Continue / Modules currently bounce to the website).
10. **First-run onboarding** (3 steps) + every stats screen ends with one clear CTA ("watch 1 lesson to keep your streak").

Recommended order: #1, #2, #3 (quick wins) → #6, #7, #8 (big levers) → the rest.

## Code pointers (bot)
- `supabase/functions/telegram-bot-webhook/index.ts`
  - Student commands: `/galaba` (📊 Statistikam), `/vazifalar` (📝 Mening vazifalarim), `/davom`, `/dars`.
  - Localized strings (uz/ru/en) in the big `T` table near the top: `statsTitle`, `statsLessons`, `statsHomework`, `statsHomeworkPoints`, `statsRanking`, `statsBadges`, etc.
- Data sources: `recalc_leaderboard` / `leaderboard_cache` (rank, score), `streaks`, `daily_watch_summary`, badge tables, `public.user_homework_avg10_effective`.

## What shipped 2026-06-09 (don't redo)
- Vault internal-secret hardening on all cron/DB edge fns + `notify-completion`; `notify-admin-new-student` → `verify_jwt=true`.
- Leaderboard correctness + 15-min recalc cron.
- **Role-revert bug fixed**: `enforce_role_exclusivity` trigger now auto-removes the conflicting role (migration `20260609120000`). Setting teacher/student sticks from every path.
- **Teacher multi-group switch**: added `🔄 Guruhni almashtirish` keyboard button; refreshed all teachers' keyboards via one-off `refresh-teacher-keyboards` edge fn.
- **Admin "Log in as" impersonation** (web + bot), read-only. Web: `admin-impersonate` edge fn + magic-link reuse (`/auth/magic?t=…&imp=1`), `ImpersonationBanner`, `src/lib/impersonationGuard.ts` (blocks writes). Bot: `/asteacher` & `/aststudent`, with a central `_clicker/_effId/_effPersona/_isImp` resolver in `handleCallback` so every teacher + student callback honors impersonation and read-only. Spec: `docs/superpowers/specs/2026-06-09-admin-impersonation-design.md`.

## Deferred follow-ups (not blocking gamification)
- `bot_sessions` is single-row-per-user: impersonate vs `teacher_broadcast` state can overwrite each other (low risk).
- Teachers have no dedicated web UI (bot-first) — impersonating a teacher on the web shows the admin shell. Decide whether a teacher web dashboard is wanted.
- Two unexplained `401`s seen in the admin web console during a health check (never root-caused; likely harmless).
