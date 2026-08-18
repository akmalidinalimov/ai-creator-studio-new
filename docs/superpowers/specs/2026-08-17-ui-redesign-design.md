# AI Creators — UI Redesign Design Spec

**Status:** Approved — visual language locked (Graphite & Emerald palette, Onest/Unbounded type). Ready for implementation planning.
**Date:** 2026-08-17 (revised 2026-08-18: palette → Graphite & Emerald, fonts → Onest/Unbounded/Playfair, badges + certificates added).
**Interactive mockup (v4):** the 11-screen student Mini App, live nav, Graphite & Emerald + Onest/Unbounded (published artifact).
**Certificate template (locked):** `docs/certificate/certificate-template.html` (+ README) — graphite Deco Frame, real logo, four variables.
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
| Feeling | Premium + gamified; Revolut-style — glossy cards, deep neutral ground |
| Palette | **"Graphite & Emerald"** — neutral **graphite** ground + **gray glossy tiles**, **emerald** as the accent (green is off the canvas), **coral** = the one action pop, gold = tiers. Dark is the premium default; a clean light mode exists. |
| Fonts | **Onest** (UI) + **Unbounded** (big numbers/headlines); **Playfair Display** (certificate title). Embedded as data-URIs. |
| Scope | Whole platform, **phased** (student first) |
| Homework files | **Hybrid retention** (compress + delete-graded-after-7-days + course-end purge) |
| Badges | **DM-only** (Cloudinary on-demand); profile shows a **list** of earned badges (icon-based); **no PNGs stored** |
| Certificates | **Per-module, on-demand + DM + downloadable, not stored**; template committed (`docs/certificate/`) |
| Nav | 5-tab bottom bar; **Homework is a first-class tab** |
| Theme | **Enforce the brand** light/dark, mapped from Telegram's `colorScheme` |

---

## 2. Design language

### 2.1 Color — "Graphite & Emerald"
A **neutral graphite ground with gray glossy tiles**, where **emerald is the accent** (hero, progress, tiers, badges — *not* the canvas) and **coral is the single primary-action pop**. Gold marks achievement tiers. Neutrals are graphite/gray, **not green** (the owner explicitly rejected "green everywhere" and "too dark"). **Dark is the premium default**; a clean light mode is defined for light preference / Telegram light theme.

**Tokens** (space-separated HSL in CSS; hex shown for clarity). **Dark = default:**
| Token | Dark (default) | Light | Role |
|---|---|---|---|
| `--bg` | `#15191B` | `#F2F4F3` | app background (graphite / soft gray) |
| `--surface` | `#22282B` | `#FFFFFF` | cards (dark: glossy gradient `#262D31→#1B2125` + inset top-highlight) |
| `--surface-2` | `#262D31` | `#F5F8F6` | inset/secondary surfaces |
| `--ink` | `#EDF1F0` | `#0C2624` | primary text |
| `--muted` | `#9AA5A2` | `#5E7370` | secondary text |
| `--border` | `#2B3237` | `#DDE9E5` | hairlines |
| `--tint` | `#242B2E` | `#E7EEEC` | **neutral gray** fills (progress track, chips) |
| `--primary` | `#2FE0B0` (emerald) | `#0F766E` (deep teal) | brand / secondary actions / progress |
| `--primary-ink` | `#06251E` | `#FFFFFF` | text on primary |
| `--accent` | `#FF6A4D` | `#FF6A4D` | **coral** — the one primary action per screen |
| `--accent-ink` | `#FFFFFF` | `#FFFFFF` | text on coral |
| `--accent-soft` | `#3A1A13` | `#FFE6DF` | coral tint (rare; not for the CTA) |
| `--gold` | `#E6C877` | `#E0A83C` | tiers / achievement |
| `--good` / `--warning` / `--danger` | `#34D399` / `#E6C877` / `#FF8C6B` | `#0F9D6B` / `#E0A83C` / `#C0512D` | semantic |

**Contrast tokens (required — text on tints must pass WCAG AA):** dark `--accent-2 #FF9178`, `--gold-2 #F0C869`, `--good-2 #34D399`, `--danger-2 #FF8C6B`; light `--accent-2 #C93B22`, `--gold-2 #8F6410`, `--good-2 #0A7A55`, `--danger-2 #A53D1F`. Status chips, tier labels, and highlighted numbers use these text tokens on their tints, never the base hue as small text.

**Accent discipline (audit M1):** solid **coral** fill is reserved for **the one primary action per screen**. **Emerald** carries gamified energy (progress, streaks, badges, hero) as fills/tints; never solid-coral a non-actionable element in the same viewport as the CTA. Green stays off the neutral canvas/tiles.

### 2.2 Typography
Unify the fonts (today `index.html` loads Clash Display/Hanken while `index.css` imports Inter/Fraunces — that inconsistency goes away). **Locked pairing (owner chose from options):**

- **Body / UI: Onest.** Clean geometric grotesque (Aeonik-adjacent → the Revolut feel), **full Cyrillic + Latin** (critical — Uzbek/Russian/English), great at small sizes.
- **Big numbers / headlines: Unbounded.** Bold, distinctive, **full Cyrillic** — used for stat values, the certificate name, celebration headlines. Not for body/long text.
- **Certificate title (only): Playfair Display** — an elegant serif used solely on the certificate title.
- Scale: display 24–28 / h 18–20 / body 14–15 / caption 12–13. Tight tracking on headings; `font-variant-numeric: tabular-nums` on all stats/XP/scores.
- **Loading:** self-hosted `@font-face` (font CDNs are blocked in the sandboxed artifact/mockup and are avoided in-app too). In mockups the variable TTFs are inlined as base64 data-URIs; in the app, serve them from `public/fonts/` with a metric-compatible fallback so there's no layout shift.

### 2.3 Shape, elevation, motion
- **Radius:** one system — 22px cards, 14px buttons, 999px pills, 16px chips. `--radius` base 0.75rem retained.
- **Elevation / gloss (the "premium" feel):** cards are a subtle gradient with an **inset top highlight** (`inset 0 1px 0 #ffffff12`) + a soft drop shadow; the hero card carries a faint **emerald glow**. Dark uses graphite shadows, not teal.
- **Motion:** short (150–350ms) ease; screen fade-in; celebration moments (submit success, level-up, tier-up, grade received) get a brief, tasteful animation. Respect `prefers-reduced-motion`.

### 2.4 Iconography
Single stroke-based set (lucide, already a dependency), 2px stroke, 22–24px. Gamified glyphs (flame, zap, trophy, crown, medals) may use fills.

---

## 3. Component library
Built on the existing shadcn/ui + Tailwind. Each is one token-driven component used on both surfaces.

- **Buttons:** `primary` (coral, one per screen), `secondary` (teal), `ghost` (tint), `block`; ≥44px tap height.
- **Cards** (`card`, `hero`), **stat tile**, **section header** (`slab` + optional action).
- **Progress:** bar, mini-bar, **ring** (conic), **tier bar** (gold→emerald gradient). Fills use emerald, not coral.
- **Gamification:** XP pill, streak chip, tier badge, reward chip, level ring, badge grid item, podium. (Certificate is a separate render-template, §6.5.)
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
5. **Profil (Profile)** — avatar, level, **tier progress (Oltin→Platina)**, stat grid, **earned-badges grid** (§6.4, icon-based, tap to view/download), **certificates** (§6.5, downloadable), streak, and settings (language, notifications, **board visibility** toggle — respects `hide_from_group_boards`).

**Drill-downs:** Lesson (video + steps + reward + submit-homework CTA + next), Homework detail (§6), Upload (§6).

**Real-world states (audit C3 — designed in v2, to be built):**
- **First-run / empty** — new enrollee with nothing to resume: a "Boshlash" home (0 XP, module 1 CTA), empty homework, empty badges, streak-0.
- **Upload lifecycle** — selecting → uploading (%/cancel) → **success (+XP celebration)** → **error/offline (auto-retry, work saved, queue)**.
- **Loading skeletons** for all screens (cold Mini App start / slow networks).
- **Feedback moments** — lesson-complete, module-complete, course-complete, level-up, tier-up, **grade received** (notification + the graded-detail reward).
- **Edge cases** — leaderboard with <3 students (podium must not break), ties, self opted-out, "you're #1/last"; **trial/provisional account** gate (homework/XP but no lessons — per project rules); locked-module tier gate; session-expired/re-auth; global offline.

---

## 6. Achievements & media — homework, badges, certificates (+ storage)

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

### 6.4 Badges — DM-only, never stored
Milestone badges are delivered by **Telegram DM** via `notify-badge-award` (`badge_award_queue`, 9pm Tashkent batch). The badge card image is **generated on-demand by Cloudinary** — a deterministic URL from the badge's pre-baked background + the student's first name (cloud `lnx5igsj`). It is **not stored in our storage**. See project docs: badge-image-pipeline.
- **In Profil:** show a **grid/list of earned badges** from the `badges` table (`icon`, `name_*`) + `user_badges.earned_at`. Tapping shows the badge larger; the full card image is re-fetched from Cloudinary on demand and can be **downloaded**.
- **Retention:** **nothing to delete** — badges cost no storage and are permanent achievements (regenerable at will). The DB keeps only the award (`user_badges = {user_id, badge_id, earned_at}`).

### 6.5 Certificates — per-module, on-demand + DM, not stored
Issued on **module completion** (and on course completion). **Previously not implemented** — the old `/sertifikat` only sent a text line and the `certificates` bucket is empty; designed fresh here.
- **Design (LOCKED, committed):** `docs/certificate/certificate-template.html` (+ README). Graphite "Deco Frame", real **AI CREATORS ACADEMY** logo (`public/logo-full.png`, black bg made transparent), gold + emerald frame with green-cube corners, Onest/Unbounded/Playfair, italic captions, no seal, renders **edge-to-edge at 1.414**. Fixed copy: *«AI CREATORS» kursining {{MODULE_NAME}} modulini muvaffaqiyatli tamomladi*; instructors **Shahlo va Akmalidin — Oʻqituvchilar: Shvetsiyadan AI Expertlar**.
- **Variables:** `{{STUDENT_NAME}}`, `{{MODULE_NAME}}`, `{{DATE}}`, `{{CERT_ID}}`.
- **Delivery:** **generated on-demand** (fill the template → render HTML→PNG, à la `render-badge`), **DM'd on completion**, **downloadable** in Profil. **Not stored permanently** — only the completion record is kept. The **course-completion** variant (owner-owned) reuses the same template with the course (not a module) in the body.

### 6.6 Storage split (rule of thumb)
| Media | Stored in our storage? | Retention |
|---|---|---|
| **Homework uploads** | yes (`homework_images`) — accumulates | hybrid delete (compress + graded-+7d + course-end purge) |
| **Badge cards** | no (Cloudinary on-demand) | keep the award record; nothing to delete |
| **Certificates** | no (rendered on-demand) | keep the completion record; DM + downloadable; nothing to delete |

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
1. **Foundation:** apply the **Graphite & Emerald** tokens (dark default + light) + self-host **Onest/Unbounded/Playfair** in `index.css`/`public/fonts/` (replacing the mixed Clash/Inter/Fraunces); build the Telegram-vs-web **AppShell** (BackButton/header/viewport/theme). Existing app keeps working — tokens change values, not structure; admin inherits automatically.
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
- **Achievements:** badge award → DM fires + appears in the Profil list (no bucket write); module completion → certificate renders from the template (correct name/module/date/id), DMs, downloads, and is **not** persisted.

---

## 11. Open decisions to confirm during planning
- Exact image-compression parameters (max dimension / quality) — tune on real submissions.
- Whether the 7-day homework grace is global or per-course configurable.
- Certificate `{{CERT_ID}}` scheme (uniqueness + any public verification lookup) and where certs render (an edge function like `render-badge`, HTML→PNG).
- (Resolved: palette = Graphite & Emerald; fonts = Onest + Unbounded + Playfair; badges DM-only; certificates on-demand + DM, not stored.)
