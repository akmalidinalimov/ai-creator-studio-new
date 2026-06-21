# Platform Assessment — 2026-06-22

_Method: a 21-agent code-grounded audit (every component + cross-cutting security, database, UI/UX, testing, migration-cost, and feature-readiness passes), consolidated by a lead-architect synthesis. ~2.1M tokens of analysis, 654 tool calls. Supersedes/extends `docs/audit-2026-06-12.md`._

## TL;DR — the three questions you asked

1. **What language is it written in?** **TypeScript, end-to-end** (React frontend + Deno/TypeScript Supabase edge functions) **plus SQL** (≈8,000 lines of Postgres logic). There is no second language to "find."
2. **Should you rewrite it (to Python/Java)?** **No.** A rewrite makes your #1 problem ("fix one thing → another breaks") *worse*, not better — it throws away ~13 already-fixed bugs and the invariants baked into 157 RLS policies + 31 triggers, and re-derives the riskiest code (the 4,737-line bot) with no test net. Keep TypeScript. Evidence and effort numbers below.
3. **Lovable vs Hostinger VPS vs managed?** **Managed.** Migrate the frontend to **Vercel or Cloudflare Pages** and the backend to **Supabase Cloud Pro** — **~$45–75/mo all-in, ~5–8 days of work.** Lovable lock-in is shallow (4 removable hooks). A self-hosted VPS would make you own backups/security/uptime for ~500 paying students — a reliability *downgrade*, not worth ~$100/yr saved.

## Overall health: **2 / 5**

A real, revenue-generating platform that is **more mature than it looks** (the effective-grade pipeline is unified in SQL, quiz grading is server-side, leaderboard RLS is locked down) — but **structurally fragile**, with serious **live security holes** and **zero automated test coverage**.

---

## Root cause of "fix one thing → another breaks"

**The core disease:** _the same business rule is implemented many times, in many layers, with no single source of truth and no test pinning them together._ Concretely:

- **Lesson completion** is written from **5 divergent client paths with 3 different thresholds** (`src/pages/LessonPage.tsx` + the `track_video_progress` RPC). 4 of the 5 bypass the canonical RPC, so they silently skip watch-time accumulation **and** the celebration/certificate hook.
- The **homework effective-grade rule** exists in **3 hand-synced copies** (`src/lib/homeworkStats.ts`, the bot's `homework-stats.ts`, SQL views) **+ 4 inline reimplementations** in the bot **+ 4 divergent SQL average formulas**; teacher `/ttop` ranks by a **5th, wrong** formula.
- There is **effectively zero automated test coverage** (4 test files, one a placeholder; **no CI** — `.github/workflows` absent). Nothing catches a divergence until a student or teacher sees a wrong number.

**Three reinforcing causes:**
1. **Security is enforced in the browser, not the server.** Impersonation "read-only" is a `localStorage` flag + a client monkey-patch that misses every `functions.invoke`/storage write and is trivially removed. Paid-tier access can be **self-granted**. Lesson video IDs are **directly SELECTable**, bypassing the access-gated edge function.
2. **Migration/cron drift.** Core crons (streak reset, nudges, badge DMs, leaderboard recalc, digests) exist **only in the live DB**, not in the 114 migrations — a rebuild silently loses them; the repo is not a faithful source of truth.
3. **The stats backbone was never finished.** `profiles.stats_dirty_at` is written in one place and **read by nothing**; `leaderboard_cache` is a 15-min full `DELETE`+re-`INSERT` (always stale, momentarily empty mid-run). Every feature built on it appears to "break" after unrelated changes.

**The two highest-risk concentrations:** the **4,737-line `telegram-bot-webhook` monolith** (one slip downs all bot commands) and the **impersonation + self-enrollment access-control chain** (full account takeover + free access to paid content).

---

## Component scorecard

| Score | Component | Headline |
|:---:|---|---|
| 2/5 | FE: Auth & access control | Impersonation read-only & role gating are client-trust only; superadmin role bricks admin access; zero auth tests |
| 3/5 | FE: Student learning | 5 divergent completion-write paths (3 thresholds); Bunny videoRef always null; N+1 queries, no error states |
| 2/5 | FE: Gamification & social | Reward pipeline hardcoded 1:1 (you want 9×16); badges vs rewards disconnected; duplicated fetching; broken download UX |
| 2/5 | FE: Homework | Web grading skips bot side-effects (stale stats, student unnotified); effective-grade logic triplicated; submission is Telegram-only |
| 3/5 | FE: Admin panel | Superadmin lockout trap; dashboard vs user-list metric mismatch; destructive mutations bypass audit log; 2,026-line god component |
| 3/5 | FE: Landing & sales intake | Create-student shared secret cached in browser; divergent status enums; fake trust numbers; no rate limit on public endpoint |
| 3/5 | FE: Settings / i18n / layout | Two competing language-write paths; hardcoded Uzbek on student surfaces (RU/EN broken); unvalidated goal/timezone feed stats |
| 2/5 | BE: Telegram bot monolith | 4,737-line god-function; leaf/grade logic reimplemented 4+ times; `/ttop` wrong formula; no `update_id` idempotency (replay double-counts) |
| 2/5 | BE: Auth & login functions | `verify_jwt` config drift can 401 all logins on redeploy; status poll re-mints session (flaky); username-fallback can bind wrong account |
| 2/5 | BE: Admin functions | Impersonation grants a real full-privilege session; any admin can mint admins; duplicate config block; audit logging unreliable |
| 3/5 | BE: Video pipeline | `bunny-sign` leaks secret metadata (debug oracle); unsigned shareable embeds bypass tier gating; migrate deletes source before verifying |
| 2/5 | BE: Gamification engine | Streak freeze fakes activity; badge triggers run course-wide aggregates on every video heartbeat; crons not in version control |
| 2/5 | BE: Notifications & cron | Core crons only in live DB (drift); sends marked successful without checking Telegram `ok`; no-teacher submissions notify nobody for 24h |
| 3/5 | BE: Sheets onboarding + AI | `study-assistant` trusts client chat roles (prompt injection) + no enrollment check (cross-course leak) + no rate/token cap |
| 3/5 | XC: Database & data integrity | Migration/cron drift; 7 stats-critical tables have no foreign keys; certificate subsystem dropped; 4 divergent homework formulas |
| 2/5 | XC: Security (OWASP) | Self-enrollment + NULL-tier = full paid-tier bypass; lesson video IDs publicly SELECTable; committed `.env` is public keys only (not a leak) |
| 2/5 | XC: UI/UX & accessibility | i18n collapse on gamification/homework surfaces; certificates & 9×16 rewards unbuilt; weak loading/empty states; a11y/contrast gaps |
| 2/5 | XC: Testing & CI | No CI, no typecheck script, strict mode off; 4 test files; ~132 Postgres functions & ~36 edge functions untested |
| **4/5** | XC: Migration & portability | **Lovable lock-in is shallow (4 removable hooks); the valuable logic is portable Postgres; keep TS, migrate to managed hosting in ~5–8 days** |

---

## Master issue list (ranked)

Severity / area / blast-radius / effort (S = ≤1d, M = days, L = ~week+).

| ID | Sev | Area | Issue | Effort |
|---|---|---|---|---|
| M01 | CRIT | Testing/CI | No automated tests + no CI — the direct enabler of "fix one → break another" | M |
| M02 | CRIT | Completion | Lesson completion from 5 divergent client paths, 3 thresholds; no single `mark_lesson_complete` RPC | M |
| M03 | CRIT | Security/Auth | Impersonation read-only is client-only; minted session is a real full-privilege session (account takeover/write) | M |
| M04 | CRIT | Security/Access | Self-enrollment INSERT policy + `has_module_access` NULL-tier=unlimited = full paid-tier bypass | S–M |
| M05 | HIGH | Security/Access | Lesson `provider_video_id`/`video_url` directly SELECTable; bypasses the access-gated edge function | M |
| M06 | HIGH | Database/Ops | Cron drift: streak-reset, nudge, badge-DM, engagement, digest crons exist only in live DB | S–M |
| M07 | HIGH | Stats | Stats backbone never built: `stats_dirty_at` read by nothing; leaderboard is 15-min full DELETE+reINSERT | M |
| M08 | HIGH | Homework | Effective-grade logic triplicated + 4 inline bot copies + 4 divergent SQL formulas; `/ttop` wrong formula | M |
| M09 | HIGH | Homework | Web grading skips bot side-effects (`stats_dirty_at`, cache invalidation, student notification) | S–M |
| M10 | HIGH | Bot | 4,737-line god-function; no `update_id` idempotency (replays double-count + double-notify) | S (idem) / L (de-monolith) |
| M11 | HIGH | Security/Config | `verify_jwt` config drift + duplicate `admin-create-students` block (last-wins = public) | S |
| M12 | HIGH | Security/Authz | Any admin can create/promote admins via service-role, bypassing the superadmin gate | S |
| M13 | HIGH | Auth/Admin | `superadmin` role is assignable but unhandled in AuthContext → self-inflicted admin lockout | S |
| M14 | HIGH | Database | 7 stats-critical tables have no foreign keys; delete/merge orphans poison leaderboards/badges | S–M |
| M15 | HIGH | AI/Security/Cost | `study-assistant`: prompt injection + no enrollment check (cross-course leak) + no rate/token cap | S–M |
| M16 | HIGH | Certificates | Certificate subsystem fully dropped; you want per-module issue/renew (greenfield rebuild) | M |
| M17 | HIGH | Notifications | Sends marked OK without checking Telegram; no-teacher submissions notify nobody 24h; campaigns can double-message | M |
| M18 | HIGH | Security/Sales | `SHEET_SYNC` create-student secret shipped to browser; public `sheet-sync` has no rate limit | S–M |
| M19 | MED | Security/Video | `bunny-sign` debug/verify oracle leaks secret-derived metadata; embeds unsigned/shareable | S–M |
| M20 | MED | Gamification | Streak freeze fakes continuity; two competing advance functions; UTC-write vs Tashkent-read off-by-one | M |
| M21 | MED | Performance/DB | Badge triggers run course-wide COUNT aggregates on every video heartbeat (≤10s during playback) | S–M |
| M22 | MED | Rewards | Reward image pipeline hardcoded 1:1 square; cache key has no version/format → can't ship 9×16 or renew | M |
| M23 | MED | Security/Portability | Hardcoded anon JWT (exp 2092) + project ref embedded in migrations; rotation breaks all crons | S–M |
| M24 | MED | UI/UX/i18n | Hardcoded Uzbek on nav, gamification, homework, nudge, digest, celebration → RU/EN see mixed UI | S–M |
| M25 | MED | Admin/Audit | Destructive admin mutations (group delete, course reassign, member remove) bypass the audit log | S–M |
| M26 | MED | Admin | God-components: AdminUsers 2,026 LOC, AdminDashboard 1,088 LOC; client-computed KPIs truncate at row caps | M |
| M27 | MED | Backend | Duplicated boilerplate (CORS, secret guard, tg send, grade helpers) across ~36 functions, no `_shared` module | M |

## Dependency / blast-radius hotspots ("one write → many readers")

These are the nodes where a single change ripples — the literal source of your fragility:

1. **Lesson marked complete** → streaks, leaderboard, badges, module celebration/share-image, next-lesson DM, (planned) certificates, progress %. _Written from 5 divergent paths; the single most dangerous node._
2. **Homework graded** → student card, `/galaba`, `/vazifalar`, `/ttop`, 3 teacher-stats views, leaderboard, (planned) cert eligibility, graded-DM. _Rule lives in 8+ places; web path skips side-effects._
3. **Admin "log in as" / mints a session** → every RLS-gated table (writable), all `functions.invoke` writes, storage, certificate/reward/badge writes. _Minted session is real full-privilege; "read-only" is a removable client flag._
4. **`recalc_leaderboard` runs** → web Leaderboard, bot `/galaba` + `/ttop`, weekly-star pick, engagement tiles, MyActivity, (planned) levels/quests. _Full DELETE+reINSERT → transiently empty + always ≤15 min stale._
5. **Student row created/deleted/merged** → 7 FK-less tables orphan; tier checks; audit. _Add FKs + cascades; gate enrollment/role server-side._
6. **`track_video_progress` writes watch date** → streak gate, leaderboard minutes, heatmap. _UTC-stamped, Tashkent-read → 00:00–05:00 mis-bucketed._
7. **Edge config / cron schedule changed** → gateway auth for every function, all pg_cron jobs, all login flows. _`verify_jwt` partly lives in the dashboard not git; most crons live only in the live DB._

---

## Language & migration verdict (the evidence for "keep TypeScript")

**Lovable coupling is shallow — 4 points, all removable in ~2 days:**
- Dev-only `lovable-tagger` Vite plugin (`vite.config.ts`) — 10 min to remove.
- One Google-OAuth call site (`src/integrations/lovable/` used by `src/pages/Signup.tsx`) — replace with native `supabase.auth.signInWithOAuth`, ~0.5 day incl. Google/Supabase provider setup.
- Lovable AI gateway for image-gen + AI-tutor fallback (`generate-module-share-image`, `study-assistant`) — re-point to Gemini/OpenAI directly, ~1 day.
- One Telegram-digest gateway (`weekly-digest`) — re-point to `api.telegram.org`, ~2 hours.

**Where the real value lives (and why a rewrite is low-value):** the data/business layer — **114 migrations, ~133 Postgres functions, 31 triggers, 157 RLS policies, ~8,000 lines of SQL** — is language-agnostic and moves to managed Supabase Cloud **unchanged** via `supabase db push`. A backend rewrite re-types ~6,000 lines of glue for **zero behavioral gain** while the SQL crown jewels stay in SQL.

**Effort/risk of each path:**
- **Stay on TypeScript + migrate hosting: ~5–8 days, ~$45–75/mo.** ✅ Recommended.
- **Rewrite backend to Python/FastAPI: 4–7 months.** Re-implements Telegram HMAC + Bunny URL signing (security-critical, must be byte-identical), 38 Deno handlers, manual Supabase JWT validation, `supabase-py` admin gaps, new container hosting + re-wired crons — and re-introduces the exact bug classes you already fixed.
- **Full rewrite (frontend + backend + SQL): 10–16 months**, customer-data-risky on a live 500-student platform. Maximizes the "fix-one-break-another" problem.

> If the team has a strong long-term Python preference: port **only new** functions to FastAPI behind the same gateway — never big-bang the working ones.

## Recommended hosting plan (managed)

- **Frontend:** Vercel Hobby ($0) or Cloudflare Pages ($0) — the app is already a stock Vite SPA (`vercel.json` rewrite is correct).
- **Backend:** Supabase Cloud **Pro $25/mo** (needed at ~500 students for daily backups, no auto-pause, the cron/pg_net workload).
- **All-in ~$45–75/mo:** Supabase $25 (+~$10 headroom) + Vercel $0–20 + Bunny $5–15 (unchanged) + AI provider a few $/mo.
- **#1 cutover footgun:** the cron/SQL-editor drift (M06). Enumerate `cron.job` on the live DB and reproduce every schedule as committed migrations, or scheduled work stops silently.
- **Sequence:** do this migration **after Phase 1 robustness** so you don't migrate a moving target. It is later-phase, not blocking.

See `docs/IMPROVEMENT-ROADMAP.md` for the phased build plan and per-feature specs.
