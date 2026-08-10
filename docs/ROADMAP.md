# AI Creators — Improvement Roadmap

**Source:** 2026-08-10 platform audit (5 parallel evidence-backed sweeps).
**Companion scorecard:** https://claude.ai/code/artifact/f49c4800-c45e-40c4-ba9f-f1fe8c084777
**Overall readiness:** 6.8 / 10 — production-grade backend, under-wired experience layer.

This roadmap turns the audit into a prioritized, sequenced work queue. It is a living document —
each track becomes one or more focused specs (`docs/superpowers/specs/`) and plans
(`docs/superpowers/plans/`) as it is picked up.

---

## How priorities are rated

`Priority = (learning/business impact + risk-if-skipped) weighted against effort & dependencies.`

| Tag | Meaning |
|---|---|
| **P0 — Now** | Cheap + high-impact. Ship within a week; no dependencies. |
| **P1 — Next** | Flagship value or foundational risk. The main build queue. |
| **P2 — Soon** | Important, sequenced after the P1 foundation. |
| **P3 — Later** | Cleanup / lower urgency / larger structural work. |

Each item also carries **Impact** (Very High / High / Med / Low), **Effort** (S ≤1d · M ≤1wk · L >1wk),
and **Risk if skipped**.

---

## The queue at a glance

| When | Items |
|---|---|
| **Now (P0)** | Quick-wins bundle (6 items) — see §Quick Wins |
| **Next (P1)** | **C1 HTTP-call observability** *(in progress)* → **A in-loop engagement** → C-heal (live 403) |
| **Soon (P2)** | **B** i18n+video+onboarding → **C2** (2nd alert channel, edge error sweep) → **A** reach-fix + social layer |
| **Later (P3)** | **D** retention/indexes/React-Query/webhook-split → **C3** (auto-heal, CI migration dry-run) |

**Sequencing rationale:** harden the foundation the features will stack on (C1) → move the business
metric with cheap in-loop engagement wins (A) → fix credibility gaps students see (B) → pay down
structural debt before the next scale step (D). Owner-chosen order: **C first, then A (in-loop first).**

---

## Track A — Boost student activity  ·  Flagship  ·  Impact **Very High**

The engagement loop is leaky at both ends: the daily *trigger* reaches only ~30% of students, and the
*reward* is invisible at the moment of achievement. Owner decision: **in-loop mechanics first**, then
the reach-fix, then the social layer.

| # | Item | Priority | Impact | Effort | Risk if skipped |
|---|---|---|---|---|---|
| A1 | Make the economy **felt** — instant "+N XP" on submit/grade; a real **level-up moment** (currently silent) | **P1** | Very High | S–M | Core reward decoupled from core action; motivation leaks |
| A2 | **Un-orphan the stats screen** — add the "📊 Statistika" button so the best gamification view is reachable | **P1** | High | S | Best asset the bot has is unreachable |
| A3 | **Leaderboard windowing + weekly reset** — show gap-to-*next* (not gap-to-#1); a weekly board so late joiners aren't buried | **P1** | High | M | Bottom 80% demotivated; late joiners quit |
| A4 | **Goal-gradient nudges** — "1 lesson to finish the module", "20 XP to level up", "1 badge away" | **P1** | High | M | Near-misses never convert to completions |
| A5 | **Wire the 4 orphan badges** (level_5, perfect_score, group_top3, ambassador) + per-module badges | **P1** | Med | S | Designed rewards sit unearnable |
| A6 | **Homework-based streak** — submitting counts toward the streak (today it rewards lessons only) | **P2** | High | M | Homework-first students get no streak credit |
| A7 | **Reach the unreachable ~70%** — web push / PWA + in-app bell; a Start-conversion play | **P2** | Very High | L | The daily loop only ever fires for the already-motivated |
| A8 | **Social / relatedness layer** — group-vs-group totals, public "student of the week" in the group topic, peer-gap nudges, kudos | **P2** | Very High | L | The strongest driver for a collectivist audience stays absent |
| A9 | **Course-completion certificate** — shareable, high-status, legitimacy | **P3** | Med | M | Missing a tangible status reward |

---

## Track B — UX / UI & trust  ·  Impact **High**

| # | Item | Priority | Impact | Effort | Risk if skipped |
|---|---|---|---|---|---|
| B1 | **i18n sweep + CI guard** — externalize hardcoded-Uzbek on homework/nav/badge/celebration; fail the build on new hardcoded UI strings | **P1** | High | M | RU/EN students hit Uzbek walls on core screens |
| B2 | **Fix the video experience** — drop the epoch-ms watermark; default anti-piracy heuristics OFF on mobile/Telegram; add poster/skeleton | **P1** | High | S–M | Likely root cause of "students can't watch" |
| B3 | **New-student onboarding** — welcome, guided first lesson, group/profile nudge | **P2** | Med | M | New users land on an empty dashboard, no orientation |
| B4 | **Telegram Mini App integration** — WebApp SDK viewport/back-button/theme | **P2** | Med | M | Misses the core distribution channel's niceties |
| B5 | **Enforce design tokens** — kill hardcoded hex drift; consolidate render-blocking fonts | **P3** | Low | S | Cosmetic drift across themes |
| B6 | **Captions / transcripts** for lessons (a11y + multilingual comprehension) | **P3** | Med | L | Accessibility + comprehension gap |

---

## Track C — Reliability hardening  ·  Impact **High (risk↓)**

| # | Item | Priority | Impact | Effort | Status |
|---|---|---|---|---|---|
| **C1** | **HTTP-call observability** — durable failure log + watchdog + classifier for every `net.http_post`; heals the live 403 | **P1** | High | M | **▶ In progress** — [spec](superpowers/specs/2026-08-10-http-call-observability-design.md) · [plan](superpowers/plans/2026-08-10-http-call-observability-plan.md) |
| C2 | **Second alert channel** (email / 2nd bot) so a Telegram/pg_net outage can't blackhole alerts; **edge `console.error → platform_error_log` sweep** (29 log-only functions) | **P2** | High | M | Queued |
| C3 | **Auto-heal promotions** for safe alert-only watchdogs; **CI migration dry-run** + broader edge tests | **P3** | Med | M | Queued |
| C-runbook | **RUNBOOK.md** — alert → cause → kill-switch → remediation (ships with C1) | **P1** | Med | S | In C1 |

**Evidence note (2026-08-10):** the audit's "dead crons on old ref" and "orphan reconcile cron" were
**cleared** against live prod; the real, active problem is silent HTTP failures (31 timeouts + 2 real
403s in 6h, invisible) — which C1 targets.

---

## Track D — Architecture & security cleanup  ·  Impact **Med**

| # | Item | Priority | Impact | Effort | Risk if skipped |
|---|---|---|---|---|---|
| D1 | **Retention crons** for unbounded log tables (`webhook_inbox` 172MB, `telegram_magic_links`, `auth_events`, `group_message_events`, `notifications_log`) — DB already 623MB | **P2** | High | S | Storage/cost/scan bloat compounds |
| D2 | **Delete or membership-gate `telegram-auth`** — orphaned username-link path contradicts anti-squatting doctrine | **P2** | High | S | Account-takeover class if reachable |
| D3 | **22 FK indexes** + drop 4 duplicate / prune unused indexes (one migration) | **P2** | Med | S | FK-join/delete slowdowns at scale |
| D4 | **CI hardening** — add `deno check` + widen edge tests to all dirs; ratchet lint | **P2** | Med | S | Type/logic regressions land silently |
| D5 | **Advisor stragglers** — `search_path` on 3 functions; enable leaked-password protection; move `citext`/`vector` out of `public` | **P3** | Low | S | Standard hardening gaps |
| D6 | **Adopt React Query** + thin data/hooks layer; decompose 2,000-line admin pages | **P3** | Med | L | Client won't scale UX past a few thousand rows |
| D7 | **Split `telegram-bot-webhook/index.ts`** (7,444 lines) into per-domain modules behind the router | **P3** | Med | L | Hard to reason about; edit risk grows |

---

## Quick Wins — P0, shippable this week

Cheap + high-impact, pulled from across all audits. Momentum before the bigger tracks. (Several overlap
with A1/A2/A5/B2 — do them as a fast batch.)

| # | Win | Track | Effort |
|---|---|---|---|
| Q1 | Re-add the "📊 Statistika" button — un-orphans the best gamification screen | A2 | S |
| Q2 | Append "+N XP" to the homework receipt & grade DM | A1 | S |
| Q3 | Replace the epoch-millisecond video watermark with a human string | B2 | S |
| Q4 | Externalize hardcoded-Uzbek strings (homework/nav/badge/celebration) | B1 | S |
| Q5 | Default anti-piracy pause/devtools/FPS heuristics OFF on mobile & Telegram webview | B2 | S |
| Q6 | Wire the 4 designed-but-unearnable badges | A5 | S |

---

## Success metrics

- **North-star:** 7-day active student retention (headline for Track A).
- **Guardrails:** DM mute/block rate (Track A must not raise it); zero XP drift (already held);
  **real HTTP faults surfaced within 30 min** (Track C1); RU/EN parity honored on core screens (B1).
- **Reliability SLOs:** every automated HTTP call's outcome DB-visible; alert MTTR < 1h; no
  silent-failure classes.

---

## Change log

- **2026-08-10** — Roadmap created from platform audit. Owner picked **Track C first**, then **Track A
  in-loop mechanics first**. C1 (HTTP-call observability) in progress on `feat/reliability-c1-http-observability`.
