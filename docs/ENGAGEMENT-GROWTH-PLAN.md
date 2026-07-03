# Engagement & Growth Plan — the AI Creators Identity Loop (2026-07-03)

Consolidates the owner's ideas (profile photos, bot→web-app stats, module certificates, 9:16 branded achievement cards, Instagram sharing, homework-flow polish, trimming vanity stats) into one coherent growth system. Builds on `docs/IMPROVEMENT-ROADMAP.md` Phases 3–5.

## The loop (the whole point)

```
        ┌─────────────────────────────────────────────┐
        ▼                                             │
   ACCOMPLISH ──▶ BRANDED ARTIFACT ──▶ RANK RISES ──▶ SHARE ──▶ OTHERS WANT IN
  (lesson/hw/     (9:16 card / cert     (group        (IG story,    (enroll →
   streak/quiz)    with your FACE)       podium)       branded)      accomplish)
        ▲                                                             │
        └─────────────────────────────────────────────────────────────┘
```

Retention mechanics (streak / level / quests) keep them **accomplishing**. Artifacts + sharing convert accomplishment into **acquisition**. The card is beautiful enough that they *want* to share — we never beg.

---

## Six pillars (owner ideas, elaborated + consolidated)

### Pillar 1 — Identity foundation: real name + real face
Everything social/visual looks generic (and nobody shares it) until students have a real name and photo. Also fixes the audit's `"Talaba"` placeholder problem.
- **Auto-import the Telegram profile photo** (`getUserProfilePhotos`) as the default avatar — zero friction for ~484 existing students; they can override.
- **Avatar upload** in web Settings + a bot flow (or the Mini App). Store in a private `avatars` bucket (signed URLs).
- One-time **name-confirm** prompt for students still on `"Talaba"`.
- Avatar then appears everywhere: leaderboard rows, group podium, achievement cards, certificates.

### Pillar 2 — The Artifact Engine: one deterministic branded renderer
Achievement cards **and** certificates are the same engine — build once.
- **Deterministic** HTML/SVG → PNG via `satori` + `@resvg/resvg-js` (roadmap 4.1/4.2), **not** AI image generation (AI mis-renders names/text at 9:16 — unacceptable for something public).
- Brand kit baked in: cream/teal palette, `icon-512` logo + wordmark, `aicreator.academy`.
- Templates: 9:16 achievement card, module certificate, student-of-week, streak-milestone. All share layout primitives (avatar, name, headline, brand footer, optional QR/referral).

### Pillar 3 — The Share Loop: Instagram story mechanic (the growth engine)
- On a milestone the bot sends the 9:16 card via `sendPhoto` with copy like:
  *"🔥 30-day streak — top 5% of AI Creators. Share it: post to your Instagram story, tag @aicreators, and show the world you're building with AI. [Save image] [How to share]"*
- The card carries a **QR / short referral link** → track inbound signups per share (**attribution proves the loop works**).
- **Reward the sharer** (bonus streak-freeze / XP) — opt-in, never spam.
- Meta-layer: an "inspired the most people" board (shares that converted) turns advocacy into status.

### Pillar 4 — The Home Screen: Telegram Mini App stats
Replace the 7 dense text lines with a **Telegram Mini App** (web_app button) — opens in-Telegram, authenticated via `initData` HMAC → session. Mobile-first, one screen:
1. **Hero:** avatar + level ring + streak flame + "you're #4 in [group]".
2. **Group podium** (faces): top 3 + your row + "2 pts behind #3 — watch 1 lesson to pass".
3. **Homework:** submitted / graded / avg + pending count.
4. **Next milestone** + one CTA.
5. **Achievements gallery** + per-card share buttons.
Reuses the web app already being hardened. Bot "📊 Statistika" → opens this.

### Pillar 5 — Trim the vanity stats (focus)
Principle: **every number must answer "so what do I do next?"** — if it can't, cut it.
- **Keep:** Streak (loss aversion), Group rank + gap-to-next (social + actionable), Homework avg + pending (progress + action), Level + next milestone (monotonic accomplishment), Achievements (identity).
- **Cut / fix:** the raw 0–100 "activity score/points" (vanity, *decays*, confusing) → replace with a **monotonic Level/XP that only goes up**; fold "daily goal" into the streak nudge; kill the "Ball: X/70" denominator confusion.

### Pillar 6 — Homework flow: make submit → grade delightful
- **No silent dead-ends** — teacherless group / expired window / missing topic always DM the student a clear next step (fixes audit BOT-2).
- **Reward-reveal at submit** (peak emotion): *"✅ Submitted! 🔥 3-day streak. You're #4 — grading usually <24h."*
- **On grade → a branded result card**, not "0/10": score + teacher comment inline + "improved +2 from last time" + next CTA. Great grades auto-offer a shareable card.
- Resubmission clarity + file-type/size validation with friendly errors.
- Surface a **submission-rate** headline in stats.

---

## Sequenced execution (dependency-ordered)

| Phase | What | Who |
|---|---|---|
| **1. Foundation** | Avatars (auto-import TG photo + upload) + name-confirm | UI = me; storage bucket + bot flow = needs-apply |
| **2. Artifact engine** | Deterministic 9:16 + certificate renderer + brand kit | **Design/mockup = me (render + show now)**; edge-function generator = needs-apply |
| **3. Achievement cards + share loop** | Triggers → card → bot sendPhoto → IG CTA + referral tracking | cards/gallery UI = me; bot + referral table = needs-apply |
| **4. Certificates** | Per-module, server-issued, `/verify/:token`, reuse engine | verify page + UI = me; cert table + issuance = needs-apply |
| **5. Mini App stats** | initData auth + mobile stats screen; trim stats here | screen = me; initData auth edge fn + bot button = needs-apply |
| **6. Homework flow** | reward-reveal, result cards, no dead-ends, validation | copy/logic spec = me; bot edits = needs-apply |

**Legend:** *me* = I build + verify autonomously (frontend/design, rendered previews). *needs-apply* = I write + unit-test on a branch; you apply the migration / deploy the edge function / bot change and we verify live.

## Decisions (my recommended defaults in **bold**)
1. **Logo/brand:** use `icon-512.png` + the teal/cream palette as-is (**default**); swap if you have a richer logo/wordmark.
2. **Certificate scope:** **one per module** (vs one evolving per-course) — matches the roadmap.
3. **Reward for sharing:** **yes, opt-in** (bonus streak-freeze) — capped, never spammy.
4. **Start point:** **Phase 2 artifact design first** — the 9:16 card + cert are the visual heart; seeing them anchors every other decision.

## Metrics (prove the loop)
Baseline first (fix the "active" definition). Then: cards generated, **share→signup attribution**, streak survival (3/7/30), homework submission rate, Mini App opens/student/week, avatar+name completion %. Watch opt-out/`paused_until` for fatigue.
