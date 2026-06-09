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

## How the new session should work (process)
Do NOT jump to code. Work in this order:
1. **Clarify first (ask me, one question at a time).** Goals, definition of "engagement" for this audience, which behaviors to drive (lesson completion, homework submission, streaks, return visits), notification appetite (how aggressive), success metrics, and any hard constraints. Use the brainstorming skill.
2. **Capability check — skills/plugins.** Before researching from scratch, check whether an existing skill/plugin already covers gamification design. If none fits, **create a reusable `gamification` skill** (use the skill-creator / writing-skills skill) grounded in real frameworks, and install it to `~/.claude/skills/` so it persists. The skill should encode: the major gamification frameworks (Octalysis 8 core drives; Self-Determination Theory — autonomy/competence/relatedness; Fogg Behavior Model B=MAP; Nir Eyal's Hook model — trigger/action/variable-reward/investment; streak & loss-aversion mechanics; points/levels/badges/leaderboards done right vs. cargo-culted), WHEN each applies, common failure modes (extrinsic rewards crowding out intrinsic motivation, vanity metrics, notification fatigue), and how to measure effectiveness.
3. **Research + synthesize (deep-research skill).** Apply the skill + targeted research to OUR context (Uzbek online learners, Telegram-first, ~484 students of mixed activity). Produce a **top-10** of concrete, prioritized mechanics tailored to the bot.
4. **Prioritize with me.** I pick the highest-priority items to build.
5. **Spec → approval → build incrementally via Lovable**, verifying each change (git pull + code review; I test live in Telegram). Quick wins first, then measure, then the big levers.

## Plan-first + multi-agent execution strategy
**Always produce a written PLAN/spec and get approval before building, then execute the plan step by step.** The user has explicitly opted into multi-agent orchestration — use the Workflow tool (deterministic fan-out) and parallel Agent subagents where they genuinely save time, but be honest about the one real bottleneck.

Where parallelism helps (do these concurrently):
- **Research fan-out** — several agents research different gamification frameworks / best practices / Telegram-bot patterns in parallel → synthesize.
- **Idea generation** — agents brainstorm from distinct lenses (motivation/SDT, retention/streaks, social/leaderboard, progression/levels, onboarding) → a judge dedupes and ranks → top-10.
- **Drafting** — for each selected feature, an agent produces a self-contained, precise Lovable instruction + the exact code/strings (uz/ru/en) in parallel.
- **Verification** — after each deploy, parallel agents check different aspects (data correctness, localization, no-regression, read-only/impersonation still intact).

The bottleneck (serialize this — do NOT parallelize):
- The bot is ONE file (`telegram-bot-webhook/index.ts`) deployed through Lovable's single chat; DB changes go through the one SQL editor. So **agents PREPARE in parallel, but the orchestrator DEPLOYS to Lovable and VERIFIES one change at a time** (git pull + review + user live-test between changes). Concurrent edits to the same file/chat will collide.
- Any WEB frontend gamification (separate files) CAN be parallelized with git worktrees if in scope.

Practical loop: plan → (parallel) draft feature instruction+code → deploy ONE to Lovable → verify → next. Pipeline the drafting ahead of the serial deploys so there's always a verified-ready change queued.

## Engagement infrastructure to build on (already exists)
The platform already has notification/reminder plumbing — reuse it, don't reinvent:
- Crons: `cron-engagement` (every 30 min), `detect-and-nudge`, `cron-admin-digest`, `weekly-admin-topic-check`, `recalc-leaderboard` (15 min). pg_cron + `net.http_post`.
- Smart nudges: rate-limited + opt-out (`nudge_log`, `re_engagement_deliveries`, `homework_teacher_dm_queue`, `bot_broadcast_rate`). Respect these — do NOT spam.
- Signals to drive/measure gamification: `daily_watch_summary`, `lesson_progress`, `streaks`, `leaderboard_cache`, badge tables, `homework_submissions`.
- Localization: every student-facing string is uz/ru/en in the `T` table — new copy must be added in all three.

## Success metrics (define + track from day one)
Pick a few and measure before/after: 7-day active students, lesson completions/day, homework submission rate, streak retention (3/7/30-day), and re-activation of dormant users. The dashboard already surfaces several of these.

## Constraints / guardrails
- Notification fatigue is the #1 risk — respect opt-out + rate limits; prefer well-timed, personal, actionable nudges over volume.
- Keep all changes data-safe (no destructive migrations); additive only.
- Don't break existing flows (stats correctness, impersonation read-only, role rules).

## Deferred follow-ups (not blocking gamification)
- `bot_sessions` is single-row-per-user: impersonate vs `teacher_broadcast` state can overwrite each other (low risk).
- Teachers have no dedicated web UI (bot-first) — impersonating a teacher on the web shows the admin shell. Decide whether a teacher web dashboard is wanted.
- Two unexplained `401`s seen in the admin web console during a health check (never root-caused; likely harmless).
