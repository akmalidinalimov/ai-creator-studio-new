# Shareable Achievement Cards — Design Spec

Date: 2026-06-10
Status: Design approved pending user spec review → then implementation plan.

## Context & goal
We already reward students with badges and milestone DMs. This feature turns those private
achievements into a **public, organic-growth asset**: when a student earns a brag-worthy
milestone, the bot DMs them a beautiful, personalized 9:16 image they can post to their Instagram
Story. Each card is branded and explains the achievement in plain language, so a stranger who sees
it on Instagram learns about AI Creators Academy. The reward we already chose (recognition/status)
becomes near-zero-CAC brand awareness.

**Why it works (gamification basis):** Octalysis *Social Influence & Relatedness* + *Epic Meaning*
(broadcasting status), the Hook model's *investment → viral loop* (each student becomes a
distribution channel), and strong cultural fit — Uzbekistan is heavily Instagram-driven and
collectivist, and a sharer's friends are the same demographic (high-quality leads). See the
`gamification` skill (`~/.claude/skills/gamification/`).

## Decisions (locked with user)
| Dimension | Decision |
|---|---|
| Which achievements | **Prestige + early wins**: `module_complete`, `course_complete`, `streak_7/30/60/100`, `first_homework`, `ten_lessons` (~8 cards). Starter badges (first_lesson, five_lessons, streak_3/14) get **no** card. |
| Personalization | Student's **name** + warm congrats + plain-language achievement + brand. Outsider-legible. |
| Voice | **First-person** ("Men 7 kun uzluksiz o'rgandim!") so it reads as the student's own post. |
| Design direction | **Bold Celebration** (mockup #3): energetic teal, ribbon, confetti, gold accents. |
| Delivery | **Auto-attached to the existing badge-award DM** at the moment earned. New awards only (no retroactive burst). |
| Languages | Uzbek-first, with ru + en. |

## Card content (per milestone)
Each card has: **the real AI Creators Academy logo** (top) · badge art · ribbon ("YANGI BOSQICH!" /
"TABRIKLAYMIZ!") · student first name · first-person achievement line · one-line explainer · brand
footer (`@shahlo.alikhanova` · `aicreator.academy`) · a branded hashtag.

First-person achievement lines (uz; ru/en parallel):
- `module_complete` → "Men <Modul N>ni tamomladim! 📚"
- `course_complete` → "Men butun kursni tugatdim! 🎓"
- `streak_7` → "Men 7 kun uzluksiz o'rgandim! 🔥"
- `streak_30` → "30 kun ketma-ket o'qidim! 🔥🔥"
- `streak_60` → "60 kun to'xtovsiz! 🔥🔥"
- `streak_100` → "100 KUN! Men buni qildim! 👑"
- `first_homework` → "Birinchi uy vazifamni topshirdim! 📝"
- `ten_lessons` → "10 ta darsni tugatdim! ⭐"

Brand explainer line (same on every card, for outsiders): uz "AI Creators Academy — AI bilan
kelajak kasblarini o'rgan." (ru/en parallel). Hashtag: `#AICreatorsAcademy` (+ optional uz tag).

## Visual design
9:16 (1080×1920). Palette from the app: Samarkand teal `#0F766E`, deep teal-black `#0E2A2A`,
saffron gold `#B8860B`, cream `#FAF8F3`, soft-teal accent `#C7E5E1`. Layout per approved mockup #3.
The **real AI Creators Academy logo** (the white "AI" pixel-dissolve monogram + teal star +
"CREATORS ACADEMY" wordmark) goes on every card — top placement, and may be rendered subtle/semi-
transparent so it brands without competing with the achievement. Logo asset must be added to the
repo (e.g. `public/brand/ai-creators-logo.png`, ideally a transparent PNG and/or SVG). Badge art
should be crisp **SVG/PNG icons** (not OS emoji) so rendering is deterministic.

## Architecture
**Recommended: render the PNG server-side inside `notify-badge-award` and send it in the DM.**
- When the badge-award DM is sent (existing `notify-badge-award` edge fn, fed by
  `badge_award_queue` ← `trg_queue_badge_dm` on `user_badges`), check if the badge code is in the
  card set. If yes, render a personalized 9:16 PNG and send via Telegram `sendPhoto` (caption =
  the localized congrats + share nudge), instead of the plain `sendMessage`.
- **Render:** Satori (HTML/JSX → SVG) + resvg-wasm (SVG → PNG) in the Deno edge runtime —
  self-contained, no external service, crisp text. Bundle: the brand font(s), the logo, and per-
  milestone SVG/PNG badge icons as assets. Emoji in art are replaced by bundled icons to avoid
  emoji-font issues.
- **Risk / validation:** confirm Satori + resvg run in the Lovable/Supabase Deno edge runtime as a
  first build step (a spike). **Fallback** if not: the DM carries a button linking to a branded
  web page on `aicreator.academy/card?token=…` that renders the card (existing React/Vercel
  frontend) with a download/share button — easier rendering, extra brand exposure, but one click.

## Telegram delivery & share UX
- Card image sent via `sendPhoto` with caption (uz-first): a one-line congrats + "📲 Bu yutuqni
  Instagram Story'ngda do'stlaring bilan ulash!" + a ready-to-copy suggested caption line.
- A copyable suggested caption (with the hashtag + @handle) so posting is frictionless.
- Telegram cannot post to Instagram directly; UX optimizes for save-image → open Instagram → post.
  The brand baked into the image is what travels even without a caption.

## Brand spread & measurement
- Every card embeds `@shahlo.alikhanova`, `aicreator.academy`, and `#AICreatorsAcademy`.
- We can't see Instagram shares directly, so track proxies: a "How did you hear about us?" field at
  signup, a short/UTM link unique to the card, and watching new-signup volume after rollout.

## Guardrails
- **New awards only** — cards fire only on new milestone crossings (the badge DM already works this
  way); the earlier silent backfill means existing earners won't get a retro card. No burst.
- Respect the existing badge-DM quiet-hours scheduling (`badge_award_queue.scheduled_for`).
- Additive: extend `notify-badge-award`; don't change badge-award or streak logic.
- Keep within "moderate notifications" — only ~8 prestige milestones carry a card.

## Build phases (proposed)
1. **Spike** the Satori+resvg render in an edge fn with one milestone (`streak_7`) + real logo →
   confirm a crisp PNG. Pick render path (in-DM vs web-page fallback) based on the spike.
2. Build the card template + 8 milestone variants (art, copy uz/ru/en).
3. Wire into `notify-badge-award`: card-set check → `sendPhoto` with caption; keep plain DM for
   non-card badges.
4. Localized captions + suggested-caption copy + hashtag/link.
5. Measurement hooks (signup source field + short link).

## Verification
- Trigger a test badge award (or invoke `notify-badge-award` for a test user) and confirm a crisp,
  correctly-personalized PNG arrives in Telegram with the right language and the share nudge.
- Confirm non-card badges still send the normal text DM.
- Confirm no retroactive cards for already-earned milestones.
- After rollout, watch signup-source proxy + new-signup volume.

## Open items to confirm during build
- Final logo asset + brand font files.
- Exact ru/en translations of each line.
- Whether to add the optional on-demand "get my card" button later (deferred).
