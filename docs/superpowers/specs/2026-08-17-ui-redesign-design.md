# AI Creators — UI Redesign Design Spec

**Status:** Approved direction, ready for implementation planning
**Date:** 2026-08-17
**Interactive mockup (v2):** `scratchpad/redesign-direction.html` → published artifact (11 screens, coral, live nav)
**Supersedes/extends:** the Telegram Mini App foundation (spec `2026-08-15-telegram-mini-app-design.md`, already shipped).

---

## 1. Goal & scope

Turn the working AI Creators app into a **modern, app-like experience that feels premium and celebrates progress**, across **both surfaces** it already runs on — the **Telegram Mini App** and the **web app** — from **one shared design system**.

- **In scope (this spec):** the design language + token system + component library, the **student experience** (all student screens + real-world states), the Telegram-vs-web app shell, the **in-app homework flow + storage retention**, and the pinned gamification/XP model.
- **Phased, not all at once:** Phase 1 = design-system foundation + student screens (Mini App + web share components, so both move together). Phase 2 = the admin/teacher panels get a bespoke pass. The admin panel **auto-inherits the new tokens** in Phase 1 (so it never looks broken) but is not bespoke-redesigned until Phase 2.
- **Non-goals:** no new backend features beyond the in-app homework upload; no change to auth (the Mini App bridge is done); no marketing-site redesign; no new heavy frontend dependencies.

### Locked decisions (from brainstorming)
| Decision | Choice |
|---|---|
| Feeling | Premium + gamified accents |
| Palette | Evolve Samarkand Teal + **one vivid accent = Coral** |
| Scope | Whole platform, **phased** (student first) |
| Homework files | **Hybrid retention** (compress + delete-graded-after-7-days + course-end purge) |
| Nav | 5-tab bottom bar; **Homework is a first-class tab** |
| Theme | **Enforce the brand** light/dark, mapped from Telegram's `colorScheme` |

---

## 2. Design language

### 2.1 Color
Evolve the existing "Samarkand Teal" system. **Teal stays the calm, premium brand; Coral carries all gamified energy** (XP, streaks, tiers, progress, level-ups, the one primary CTA and active tab). Gold marks achievement tiers. Neutrals are biased teal, never flat grey.

**Light tokens** (space-separated is fine; values shown as hex for clarity):
| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#EEF6F2` | `#07110F` | app background (paper mint / deep teal-black) |
| `--surface` | `#FFFFFF` | `#0E1A18` | cards |
| `--surface-2` | `#F4F8F6` | `#12211E` | inset/secondary surfaces |
| `--ink` | `#0C2624` | `#EAF3F1` | primary text |
| `--muted` | `#5E7370` | `#8AA39E` | secondary text |
| `--border` | `#DDE9E5` | `#1E302C` | hairlines |
| `--tint` | `#E7F1EE` | `#12211E` | teal-tinted fills (progress track, chips) |
| `--primary` | `#0F766E` | `#2DD4BF` | brand / secondary actions |
| `--primary-ink` | `#FFFFFF` | `#04201C` | text on primary |
| `--accent` | `#FF6A4D` | `#FF6A4D` | **coral** — primary CTA + gamified energy |
| `--accent-ink` | `#FFFFFF` | `#FFFFFF` | text on coral |
| `--accent-soft` | `#FFE6DF` | `#3A1A13` | coral tint (decoration, chips) |
| `--gold` | `#E0A83C` | `#E0A83C` | tiers / achievement |
| `--good` / `--warning` / `--danger` | `#0F9D6B` / `#E0A83C` / `#C0512D` | (lighter on dark) | semantic |

**Contrast tokens (required — text on tints must pass WCAG AA):** `--accent-2 #C93B22`, `--gold-2 #8F6410`, `--good-2 #0A7A55`, `--danger-2 #A53D1F` (light); lighter equivalents on dark. Status chips, tier labels, and highlighted numbers use these darker text tokens on their tints, never the base hue as small text.

**Coral discipline (audit M1):** solid coral fill is reserved for **the one primary action per screen**. Gamification decoration uses `--accent-soft` (tint), never a second solid-coral fill competing with the CTA in the same viewport.

### 2.2 Typography
Unify the fonts (today `index.html` loads Clash Display/Hanken while `index.css` imports Inter/Fraunces — that inconsistency goes away).

- **Body / UI: Inter.** Full Cyrillic + Latin coverage (critical — the app is Uzbek/Russian/English), excellent small-size legibility, already in the stack.
- **Display / headings: Clash Display** for Uzbek/Latin. **Russian headings fall back to Inter (heavy weight)** — an accepted tradeoff since the primary audience is Uzbek-Latin and headings are short. (If a single face is preferred later, `Inter Tight` is the safe all-Cyrillic display fallback.)
- Scale: display 24–28 / h 18–20 / body 14–15 / caption 12–13. Tight tracking on headings; `font-variant-numeric: tabular-nums` on all stats/XP/scores.
- Load via self-hosted/`@font-face` (not blocked CDNs) with `Inter` as the metric-compatible fallback so there's no layout shift.

### 2.3 Shape, elevation, motion
- **Radius:** one system — 22px cards, 14px buttons, 999px pills, 16px chips. `--radius` base 0.75rem retained.
- **Elevation:** soft teal-tinted shadows (`--shadow`, `--shadow-elevated`), never harsh grey.
- **Motion:** short (150–350ms) ease; screen fade-in; celebration moments (submit success, level-up, tier-up, grade received) get a brief, tasteful animation. Respect `prefers-reduced-motion`.

### 2.4 Iconography
Single stroke-based set (lucide, already a dependency), 2px stroke, 22–24px. Gamified glyphs (flame, zap, trophy, crown, medals) may use fills.

---

## 3. Component library
Built on the existing shadcn/ui + Tailwind. Each is one token-driven component used on both surfaces.

- **Buttons:** `primary` (coral, one per screen), `secondary` (teal), `ghost` (tint), `block`; ≥44px tap height.
- **Cards** (`card`, `hero`), **stat tile**, **section header** (`slab` + optional action).
- **Progress:** bar, mini-bar, **ring** (conic), **tier bar** (gold→coral gradient).
- **Gamification:** XP pill, streak chip, tier badge, reward chip, level ring, badge grid item, podium.
- **Lists:** module row (done/active/locked + unlock reason), lesson row (with **"Shu yerda" you-are-here** marker), leaderboard row (self highlighted), homework item (status chip + score).
- **Homework:** status chip (`ok`/`wait`/`redo`), score, filter segmented control, dropzone, source picker (camera/gallery/file), thumbnails, feedback block.
- **Chrome:** bottom tab bar (5, safe-area aware), Telegram header adapter (§4), toast, empty-state, loading skeleton, error/offline block.
- **Feedback moments:** celebration screen (submit success, level-up, tier-up), graded-detail reward.

---

## 4. App shell & surface mapping ("one system, two shells")
The same screen components render on both surfaces; only the **chrome** differs. This resolves audit criticals **C1/C2**.

**Telegram Mini App shell:**
- **Header/back:** use Telegram's **native `BackButton`** (show on non-root screens, `onClick → router.back()`; hide on the 5 tab roots). **No in-app back button.** History is the router's, never hardcoded targets.
- **Header color/title:** `WebApp.setHeaderColor` / `setBackgroundColor` matched to the brand light/dark ground so Telegram's chrome doesn't clash (e.g. against an OLED-black Telegram theme).
- **Viewport:** fluid to `viewportStableHeight` (not a fixed height); `ready()` + `expand()`; safe-area insets on the tab bar.
- **Theme:** map `WebApp.colorScheme` → the brand's light/dark token set (enforce brand, don't inherit Telegram's arbitrary theme colors). React to `themeChanged`.
- **Bottom tabs:** Bosh · Darslar · Vazifa · Reyting · Profil (5). Labels ≥11px; verified against Russian (longer). Homework tab shows a dot when something is pending.

**Web shell:** the existing top nav + (staff) sidebar; the in-app back button *does* render here. Same screens inside.

Boot/auth is unchanged — the shipped `TelegramGate` + `tg-miniapp-auth` bridge already handles initData → session.

---

## 5. Screens (student)

**Primary (bottom tabs):**
1. **Bosh (Home)** — lean "today" dashboard: greeting + streak/tier, **Continue-learning hero** (the dominant action; resume where you left off), key stats, weekly-goal ring, a **homework status card**, and a compact course card → Darslar. *Not* the full module list.
2. **Darslar (Lessons)** — owns the module tree: a **"Qolgan joyingiz"** resume banner + all modules (done/active/locked with unlock reason); the active module expands to its lessons with the **"Shu yerda"** marker. Every module row is tappable.
3. **Vazifa (Homework)** — §6.
4. **Reyting (Leaderboard)** — Haftalik/Umumiy toggle, podium (top-3), your row highlighted, tier badges, labelled as **group-rating XP**. Needs a **sticky "your rank"** row when the user is outside the visible window.
5. **Profil (Profile)** — avatar, level, **tier progress (Oltin→Platina)**, stat grid, badges grid, streak, and settings (language, notifications, **board visibility** toggle — respects `hide_from_group_boards`).

**Drill-downs:** Lesson (video + steps + reward + submit-homework CTA + next), Homework detail (§6), Upload (§6).

**Real-world states (audit C3 — designed in v2, to be built):**
- **First-run / empty** — new enrollee with nothing to resume: a "Boshlash" home (0 XP, module 1 CTA), empty homework, empty badges, streak-0.
- **Upload lifecycle** — selecting → uploading (%/cancel) → **success (+XP celebration)** → **error/offline (auto-retry, work saved, queue)**.
- **Loading skeletons** for all screens (cold Mini App start / slow networks).
- **Feedback moments** — lesson-complete, module-complete, course-complete, level-up, tier-up, **grade received** (notification + the graded-detail reward).
- **Edge cases** — leaderboard with <3 students (podium must not break), ties, self opted-out, "you're #1/last"; **trial/provisional account** gate (homework/XP but no lessons — per project rules); locked-module tier gate; session-expired/re-auth; global offline.

---

## 6. In-app homework (new) + storage retention

### 6.1 Flow
Homework becomes a first-class in-app destination **in addition to** the existing Telegram-group upload flow (that stays; the app is an easier second door + the place to see status).
- **Hub (Vazifa):** summary (graded / pending / average), All/Waiting/Graded **filter**, and each submission with status (**Baholandi + score / Kutilmoqda + "~24 soat" hint / Qayta yuboring + resubmit button**). Tapping a graded item → **detail** (big score, submitted images, **teacher feedback**, +XP) — the reward moment. Reachable also from Home (card) and each Lesson (CTA).
- **Upload:** lesson/task context, dropzone + **camera / gallery / file**, thumbnails, optional caption, submit (+XP).

### 6.2 Wire into the EXISTING homework engine (do not build a parallel path)
An in-app submission must land in the **same tables/queues** as a group submission and obey the same rules: creates the same pending-post/submission row, respects the **SAP multi-step display** (`sap_number` not `task_number`), the XP award path (ref-key idempotent), the teacher DM/grade queue, and all detectors/watchdogs. The app upload is a new *source*, not a new *system*. (See project docs: homework-capture, homework-sap-step-display.)

### 6.3 Storage retention — Hybrid (approved)
Records/scores/feedback/XP are **kept forever**; only the media file expires. Applies to media **we** store (in-app uploads + any group media we persist to our own bucket; Telegram-hosted `file_id`s cost us nothing).
1. **No visible size limit.** Instead, **compress/resize images client-side before upload** (longest side ~1600–2000px, ~80% JPEG). ~10× smaller, invisible to students, and far more reliable on slow mobile. Non-image files pass through with a generous server safety cap.
2. **Delete graded files after a 7-day grace.** On grading, stamp `graded_at`. A daily idempotent reconciler deletes the storage object for submissions graded >7 days ago and sets `media_deleted_at`, keeping score/feedback/XP/status/timestamps. UI shows a **tombstone** ("Rasm arxivlandi · baho saqlangan") instead of a broken image.
3. **Course-deactivation purge (backstop).** When a course is turned off, sweep and delete all remaining homework media for that course (incl. never-graded stragglers), keeping records.
4. **Optional exemption:** a teacher can **⭐ pin** a standout submission (e.g. student-of-week) to skip auto-delete.

**Net:** storage only ever holds *pending* + *graded-within-7-days* media → permanently bounded regardless of total volume; grades never lost. Emit DB-visible health signals (bytes freed, deletes run, failures) per the incident doctrine; deletes are idempotent and ref-keyed.

---

## 7. Gamification & XP model (pinned — audit M3)
Three distinct, **labelled** quantities (never conflated):
- **Umumiy XP** (total course XP) — drives the **tier** (Bronze 0 / Silver 300 / Gold 600 / Platinum 1000 / Diamond 1500). Shown on Home + Profil.
- **Haftalik XP** (this week) — drives the weekly goal ring; resets Monday. Separate from tier.
- **Guruh reytingi XP** (`user_group_rating_xp`) — drives the leaderboard only. This is a *different metric* from total XP by design (see xp-ranking-primitive) and must be labelled as such on Reyting.
Tier math must be correct and consistent across Home/Profil (to-next-tier identical). Leaderboard uses `user_group_rating_xp`, never `user_course_xp`.

---

## 8. Accessibility & i18n
- Text on tints uses the `--*-2` darker tokens (≥4.5:1; ≥3:1 for ≥18px bold). Status is never color-only — keep the text label + icon.
- Tap targets ≥44px (fix the upload thumbnail "×" and any 38px squares).
- All copy is i18n-driven (uz/ru/en); number/locale formatting via i18n, not hardcoded "2 340". Layouts must absorb ~30% Russian text expansion (esp. the 5 tab labels).
- Visible focus states; `prefers-reduced-motion` honored.

---

## 9. Rollout / phasing (non-disruptive)
1. **Foundation:** unify tokens + fonts in `index.css`; build the Telegram-vs-web **AppShell** (BackButton/header/viewport/theme). Existing app keeps working — tokens change values, not structure; admin inherits automatically.
2. **Student screens** (Mini App + web share components): Home, Darslar, Lesson, Reyting, Profil + the real-world states.
3. **Homework:** in-app upload + hub + detail wired to the existing engine + the retention reconciler + course-deactivation purge.
4. **Admin/teacher (Phase 2):** bespoke pass on the panels, on the same system.
Behind a light rollout switch where sensible; the Mini App is still gated to new students until you choose to wire the entry points (menu button / onboarding deep link — owner-gated, unchanged from the Mini App spec).

---

## 10. Testing
- **Visual/UX:** the mockup is the reference; a `/design-review` pass on the built screens.
- **Frontend:** `npm run typecheck` per task (Vite build skips tsc); component-level checks for light/dark + the 3 locales (incl. Russian expansion).
- **Telegram device checks:** BackButton behavior, header/viewport, safe-area, theme follow, on iOS + Android.
- **Homework E2E:** in-app upload → lands in the same tables as group flow → grade → XP settles (reconcile, no double-award) → 7-day reconciler deletes media + keeps grade → tombstone renders → course-deactivation purge. Synthetic student, zero residue.
- **Storage:** verify compression ratio; verify reconciler is idempotent + emits health signals.

---

## 11. Open decisions to confirm during planning
- Single display face (`Inter Tight`, full Cyrillic) vs `Clash Display` + Inter fallback for Russian headings — **recommended: Clash Display + Inter fallback** (distinctive for the Uzbek-Latin majority).
- Exact compression parameters (max dimension / quality) — tune on real submissions.
- Whether the 7-day grace is global or per-course configurable.
