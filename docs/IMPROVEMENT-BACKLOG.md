# AI Creators — Improvement Backlog (task-level spec)

**Source:** 2026-08-10 platform audit (5 parallel sweeps) → verified task-by-task against current code.
**Companion docs:** strategic priorities in [ROADMAP.md](ROADMAP.md); rated audit → the
[scorecard artifact](https://claude.ai/code/artifact/f49c4800-c45e-40c4-ba9f-f1fe8c084777).
**Purpose:** every improvement item, broken into concrete tasks with **files · what to reuse · effort ·
dependencies**, so we can decide *what runs when*. This is a menu, not a commitment.

**Legend** — Effort: **S** ≤1d · **M** ≤1wk · **L** >1wk. Priority: **P0** now / **P1** next /
**P2** soon / **P3** later. DB = needs a new migration. All migrations auto-apply only on merge with
the `migration-approved` label; self-merge needs the owner's explicit "merge it".

## Status snapshot
| Track | State |
|---|---|
| **C1** HTTP-call observability | ✅ Built → **PR #54** (awaiting label + merge). RUNBOOK.md shipped with it. |
| A · B · C2–C3 · D | Specced below, not started. Owner decides sequence. |

---

## Track A — Boost student activity  ·  Flagship  ·  owner order: *in-loop mechanics first*

**Architecture facts that shape every task (verified):**
- **XP is 100% DB-trigger-driven — the bot never calls `award_xp`.** `award_xp()` is `perform`ed only
  by triggers on `lesson_progress`/`homework_submissions`/streaks (`20260706090000_profile_gamification_phase1.sql`).
  So no "level delta" exists at any bot call site — level-up detection must be a **new AFTER UPDATE
  trigger on `user_xp`** (`old.level < new.level`).
- **Reusable async "celebration DM" pipeline:** `queue_badge_dm()` trigger → `badge_award_queue` →
  `notify-badge-award` (atomic lease, retry/terminal classify, quiet-hours, health). Clone this for
  level-ups; don't invent a new delivery path.
- **Two ranking systems coexist:** the new XP system (`user_xp`/`xp_events`/`group_leaderboard`) drives
  the web + profile card; a **legacy** points system (`leaderboard_cache`) still drives the bot's
  `buildStatsMessage`. New work sits on `xp_events`.
- **~70% of students are DM-unreachable** (never pressed Start). Never gate a state write on DM
  delivery; pair every DM with a web/in-context surface. Goal-gradient nudges self-select the reachable.
- **Badge *images* come from `CODE_TO_IMG` (Cloudinary) in `notify-badge-award`, not `badge-presets.ts`**
  (that file feeds `render-badge` only). A new badge ships as **text** unless you also add a Cloudinary
  background + `CODE_TO_IMG` entry.

| ID | Task | Effort | DB | Deps | Files · reuse |
|---|---|---|---|---|---|
| **A2.1** | **Un-orphan stats/badges/group** — add 3 inline buttons to the profile card firing the *already-wired* `prof:stats`/`prof:badges`/`prof:group` callbacks (builders exist; no button emits them today). Preferred over re-adding a reply-keyboard button (cached-layout risk). | **S** | N | — | `telegram-bot-webhook/index.ts` `buildProfileCard` ~1102-1105; labels `btnProfStats/Badges/Group` already defined ~1007-1058 |
| **A1.1** | **"+N XP" in bot submit receipt & grade DM** — amounts are fixed constants, no round-trip. Append "+15 XP" to `hwReceived`; "+25 XP" to `gradeStudentDM` only when score≥9. | **S** | N | — | `index.ts` `hwReceived` ~358/636/914, `gradeStudentDM` ~279/565/843, send ~4225 |
| **A1.2** | **"+N XP"/badge toast on web** — read `user_xp`, diff vs `localStorage`, toast. Copy the existing `seen_badges` toast pattern. | **S** | N | — | `src/components/dashboard/EngagementTiles.tsx` ~36-48 |
| **A1.3** | **Level-up moment** — AFTER UPDATE trigger on `user_xp` firing when `new.level>new.level`→ enqueue to `level_up_queue`; worker clones/extends `notify-badge-award`. Per-(user,level) unique guard; disable trigger for bulk recompute. | **M** | Y | — | reuse `queue_badge_dm` shape (`20260708053000_courses_badges_enabled.sql:12`); worker `functions/notify-badge-award/` |
| **A3.1** | **Leaderboard gap-to-NEXT** (client-only) — use the row above `me.rank`, not `#1`; neighbors derivable from the RPC's ordered board. | **S** | N | — | `src/pages/Leaderboard.tsx` ~53-114, `Profile.tsx` ~630, bot `buildGroupBoardMessage`; reuse gap-to-above at `index.ts:2360-2363` |
| **A3.2** | **Weekly-reset leaderboard** — new RPC `group_leaderboard_weekly()`; adapt `teacher_leaderboard` (already sums `xp_events` over a Tashkent-week with prev-week/rank for ↑↓). Add weekly/all-time toggle. | **M** | Y | — | reuse `20260708130000_teacher_leaderboard.sql:11-56` + members CTE from `group_leaderboard` |
| **A4.1** | **Goal-gradient nudge "N XP to level up"** — new candidate RPC (≤~20 XP from threshold); register a nudge type. Reuse the whole `detect-and-nudge` engine (opt-in, quiet hours, fatigue cap, admin-editable templates). | **S–M** | Y | — | `functions/detect-and-nudge/index.ts` (`isEligible`, `runStuckLesson` template); data: `profile_stats.xp_next_level` |
| **A4.2** | **Nudge "1 lesson to finish module"** — candidate RPC reusing module-completion math. | **M** | Y | — | reuse `evaluate_lesson_badges` completion math + `nudge_candidates_stuck` template |
| **A4.3** | **Nudge "1 badge away"** — invert the badge reconciler's "deserved" CTE; scope to five/ten-lessons + streak_7 first. | **M–L** | Y | A5 | reuse `20260716130000` reconciler criteria |
| **A5.1** | **Wire badge `level_5`** — seed row; award inside the A1.3 `user_xp` trigger when `level>=5`; add to reconciler. | **S** | Y | A1.3 | badge pattern: seed→`award_badge`→`evaluate_*`→reconciler |
| **A5.2** | **Wire badge `perfect_score`** — trigger on `homework_submissions` when `score>=max_score`. | **S–M** | Y | — | model on `xp_on_homework` (`20260706090000:115-135`) |
| **A5.3** | **Wire badge `group_top3`** — weekly cron awarding rank≤3 from the weekly board (not a row trigger). | **M** | Y | A3.2 | + reconciler |
| **A5.4** | **Wire badge `ambassador`** — needs a share-tracking signal first (share-confirm callback on the badge card, or manual admin award). Product decision. | **M** | Y | product | `notify-badge-award` already sends a share prompt ~161-163 |
| **A5.5** | **Per-module completion badges** — seed `module_1..N_complete`, extend `evaluate_lesson_badges` + reconciler + `CODE_TO_IMG` (render side already supports `{n}`). Bounded by ~8 modules. | **M** | Y | — | today a single `module_complete` fires for any module |

**Suggested A order:** A2.1 → A1.1+A1.2 → A1.3 (unlocks A5.1) → A5.2/A5.5 → A3.1 → A3.2 (unlocks A5.3) → A4.1→A4.2→A4.3.

---

## Track B — UX / UI & trust  ·  Impact **High**

**Verified corrections:** `HomeworkSection.tsx` and `ProtectedVideo.tsx` live under
`src/components/lesson/`. The Telegram WebApp SDK is **already used** in `src/pages/TgBroadcast.tsx:45-66`
(load-with-retry, `ready()`/`expand()`) — B4 is "extract + apply to the app shell," not greenfield.
`--success`/`--warning` exist in `index.css` but are **not** mapped in `tailwind.config.ts` (prereq for B5).

| ID | Task | Effort | Deps | Files · reuse |
|---|---|---|---|---|
| **B1a** | **Externalize hardcoded-Uzbek** on core screens into the parity `uz/ru/en` locale files (~40 strings, keys drafted). ru/en copy needs the content owner. | **M** | — | `StudentBottomNav.tsx:10-14`, `components/lesson/HomeworkSection.tsx` (~142-216), `dashboard/EngagementTiles.tsx` (~44-96), `ModuleCelebrationModal.tsx` (~42-126), `QuizPage.tsx` (~85-90); pattern `src/i18n/index.ts` + `useTranslation` |
| **B1b** | **CI guard** — `scripts/check-i18n.mjs` flags user-facing strings outside `t(...)`; advisory-first (ratcheting baseline), wired into `ci.yml` web job. | **S** | B1a | mirror `scripts/check-config-toml.mjs` + the `Lint (advisory)` step |
| **B2** | **Video fixes** — (a) replace both `Date.now()` watermarks with a human string + delete the 5s/2s intervals; (b) default `pause_on_blur`/`devtools`/FPS-watchdog **OFF** on touch/Telegram, and **gate the currently-ungated** keydown + FPS effects behind their settings; (c) add an aspect-ratio Skeleton for the pre-resolve/native-poster state. | **M** | shares `platform.ts` w/ B4 | `BunnyVideoPlayer.tsx` ~58-161, `components/lesson/ProtectedVideo.tsx` ~12-199, `LessonPage.tsx` ~336-350; reuse `use-mobile.tsx`, `ui/skeleton` |
| **B3** | **New-student onboarding** — first-login welcome modal → CTA into the existing `fresh` resume card's first lesson. Gate on a distinct flag (don't collide with `ModuleCelebrationModal`); set it on both signup paths. | **M** | B1 (copy) | `Signup.tsx` ~43-54, `Dashboard.tsx` ~47-152; reuse `ModuleCelebrationModal` Dialog + `seen_badges` flag pattern |
| **B4** | **Telegram Mini App** — extract the SDK loader into `src/lib/platform.ts`/`useTelegramWebApp()`; `ready()`+`expand()` at boot; map `themeParams`→CSS vars / `.dark`; wire `BackButton`→router. Guard so normal web is unaffected. | **M** | shares `platform.ts` w/ B2 | reuse `TgBroadcast.tsx:45-66`; hook into `main.tsx`/`App.tsx` |
| **B5** | **Design-token drift** — map `success`/`warning` into `tailwind.config.ts` (prereq), then swap the clear cases: `Layout.tsx:24`→`bg-primary`, `HomeworkSection` status badges→`bg-success`/`bg-warning`, `Leaderboard.tsx:61`→`text-gold`. Optional `scripts/check-tokens.mjs` lint. **Scope out** the Profile gamification palette + Landing page (separate design task). | **M** | — | `src/index.css` + `tailwind.config.ts` |

**Shared prereqs:** build `src/lib/platform.ts` (`isTouchDevice()`, `isTelegramWebView()`) once for B2+B4; map Tailwind `success`/`warning` for B5.

---

## Track C — Reliability hardening

| ID | Task | Effort | Deps | Files · reuse |
|---|---|---|---|---|
| **C1** | **HTTP-call observability** — ✅ done, **PR #54**. | — | — | `20260810130000/130100`, RUNBOOK.md |
| **C2a** | **Second, independent alert channel for CRITICAL** — cheapest = a 2nd Telegram bot/chat (reuses `net.http_post`+`platform_settings`); stronger = email via a new `email-notify` fn. Must not share the failing Telegram token/pg_net path. Dormant-until-configured. | **M** | — | clone `functions/ops-notify/index.ts`; secret via `ops_notify_secret()`/`internal_fn_secret()` Vault pattern |
| **C2b** | **Edge error-visibility sweep** — extract `logError()`→`_shared/log-error.ts`; migrate the ~30 `console.error`-only functions (start: `login-guard`, `magic-link-redeem`, `log-auth-event`, `notify-*`, `broadcast-core`, `staff-intake`, `bunny-*`, `sheet-sync`); fold `study-assistant`'s `ai_chat_errors` into the digest. | **M** | — | reuse `index.ts:1466-1484` logError + `platform_error_log` (`20260717070000`) |
| **C3a** | **Auto-heal promotions** — safe idempotent re-queue for **badge**, **broadcast**, **teacher-DM** watchdogs (reset transient-failed rows, `attempts<5`, audit). **Keep alert-only:** enrollment (destructive delete), web-traffic, cron-failure. | **M** | C2b | `badge_dm_watchdog`/`broadcast`/`hw_dm_queue_watchdog` migrations |
| **C3b** | **CI hardening** — add `deno check` + widen `deno test` to all function dirs; optional migration dry-run. Gates D-track SQL + the D6 split. | **S** | — | `.github/workflows/ci.yml` (edge job) |

---

## Track D — Architecture & security cleanup

| ID | Task | Effort | Deps | Files · reuse |
|---|---|---|---|---|
| **D1** | **Retention crons** for `webhook_inbox`, `telegram_magic_links`, `auth_events`, `group_message_events`, `notifications_log` (none have retention; DB already 623MB). Windows TBD with owner; keep beyond watchdog lookbacks (`notifications_log` 6h, `auth_events` 7d baseline). | **S** | — | mirror `20260703120000_message_retention.sql` |
| **D2** | **Delete `telegram-auth`** — confirmed orphaned (0 `src/` callers) and its username-backfill has **no membership gate** (anti-squatting risk). Remove fn + `config.toml` entry; check invocation logs for external URL callers first (else add the gate). | **S** | — | `functions/telegram-auth/index.ts:71-100` |
| **D3** | **FK indexes + drop dups** — one migration: add the **22** missing FK indexes, drop the **4** duplicate indexes (drop the plain one, keep the constraint-backed). Leave 23 unused as INFO. Use `CREATE INDEX CONCURRENTLY` (out-of-txn caveat). | **S** | — | exact names in the verified task list (advisors, project cdyidatkegxwhtuoqxly) |
| **D5** | **Advisor hardening** — `set search_path` on `xp_threshold_for`/`xp_level_for`/`touch_badge_messages`; move `citext`/`vector` to an `extensions` schema (grep qualified refs first); enable leaked-password protection (dashboard toggle). Can share a PR with D3. | **S** | — | gamification migrations + Auth settings |
| **D4** | **React Query adoption** — thin `src/hooks/queries/` layer wrapping existing `supabase.from`/RPC calls; pilot the heaviest client-aggregation pages first, then expand page-by-page. | **L** (pilot **M**) | — | pilots: `AdminStudentDetail` (29 fetches), `AdminUsers` (21), `AdminGroups` (20), `AdminDashboard` (17) |
| **D6** | **Split `telegram-bot-webhook/index.ts`** (7,444 lines) into per-domain modules behind the router (`tg-api`, `i18n`, `commands-student/teacher/admin`, `broadcast`), each with a co-located test. Vertical slices, one PR per module, no behavior change. | **L** | C3b, C2b | pattern: existing `homework-routing.ts`/`homework-stats.ts`/`ops-approve.ts` |

---

## Quick wins (P0) — one fast batch
Q1 = **A2.1** · Q2 = **A1.1** · Q3 = **B2(a)** watermark · Q4 = **B1a** strings · Q5 = **B2(b)** anti-piracy mobile defaults · Q6 = **A5.1/A5.2** orphan badges. All **S**; ship together for momentum.

## Cross-cutting constraints (apply to every task)
- Telegram `callback_data ≤ 64 bytes`; bots can't DM the ~70% who never pressed Start; group-visible buttons need owner locks.
- XP is **ref-key idempotent** — every new queue (level-up, group_top3) needs an equivalent unique guard; silence bulk backfills by disabling the DM trigger per-statement.
- New features must emit **DB-visible health signals** (incident doctrine); heal-then-detect, never patch the instance.
- Migrations: new files, `migration-approved` label, ledgered; never `db push`. Secret values are owner-entered, never printed.

## Suggested execution waves (owner decides timing)
1. **Wave 0 — ship C1:** label + merge PR #54, run its post-merge verification.
2. **Wave 1 — Quick wins (P0):** Q1–Q6 as one batch (immediate student-visible lift + risk fixes).
3. **Wave 2 — Reliability foundation:** C3b (CI gate) → D1 · D3 · D5 (small SQL) → C2b (`_shared/log-error`) → C2a · C3a.
4. **Wave 3 — Engagement depth (Track A):** A1.3 → A5.x → A3.x → A4.x.
5. **Wave 4 — UX depth (Track B):** B1 (i18n+guard) → `platform.ts` → B2/B3/B4 → B5.
6. **Wave 5 — Structural:** D2 (quick delete) → D6 (after CI covers it) → D4 (largest, last).

## Verification per track (how we'll prove each is done)
- **A/gamification:** synthetic student via `admin-create-students`; assert XP totals settle (idempotent), badge/level-up DM enqueued once, leaderboard math; delete synthetic, assert zero residue.
- **B/web:** i18n parity check (no missing keys across uz/ru/en) + the CI guard green; manual video check on mobile + Telegram webview; onboarding first-run flag fires once.
- **C/reliability:** each new watchdog emits a health signal + the external verifier asserts it; synthetic fault → alert → dedup; auto-heal is idempotent + audited.
- **D:** advisors re-run clean for fixed items; retention crons show row deletions; `deno check`/tests green; React-Query pilots behave identically (same RLS/RPC).
