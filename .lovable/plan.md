# v1.5 — Samarkand Teal Brand, Public Landing, Dashboard Upgrades

A single-pass build covering the brand re-skin, a new public marketing page at `/`, dashboard hero upgrades, an admin landing-page editor, and several small polish fixes. All existing functionality (auth flows, course editor, video upload, Telegram login, AI assistant, analytics, CSV import, i18n) stays intact.

---

## A. Samarkand Teal brand theme (platform-wide)

**`src/index.css`** — replace the `:root` block with the warm cream + Persian teal palette:
- Light mode (used everywhere except `/lesson/*`): cream `#FAF8F3` bg, deep teal-black `#0E2A2A` text, primary `#0F766E`, accent `#C7E5E1`, border `#E8DFCC`, destructive `#B5512D`, plus a new `--gold: #B8860B` token.
- Add a `.lesson-dark` scoped class with the dark teal palette (bg `#08100F`, primary `#2DD4BF`, etc.). **No global dark toggle** — only the lesson page root mounts it (deferred to section F).
- Update `--radius` to `0.75rem`, `--shadow-soft`/`--shadow-elevated` to teal-tinted shadows.
- Add `--gold` to Tailwind colors via `tailwind.config.ts`.

**`tailwind.config.ts`** — extend `fontFamily.serif: ['Fraunces', 'Georgia', 'serif']` and add the `gold` color from the CSS var. Inter stays as the default sans.

**`src/index.css` `@import`** — add Fraunces (weights 500/600/700) alongside the existing Inter import.

**Logo refresh** (`src/components/Layout.tsx` `Logo`):
- 28×28 rounded square (8px radius), `bg-primary`, white "A" inside (Inter Bold 13px), with a 3px outer ring at `rgba(15,118,110,0.08)`. Used everywhere the brand mark appears (TopNav, AuthShell, Landing nav, Footer).

**Favicon**:
- Create `public/favicon.svg` — 32×32 rounded teal square `#0F766E` with a centered white "A".
- Delete `public/favicon.ico` (browsers default-request it; leaving it would override).
- Update `index.html` `<head>` to reference `/favicon.svg`.
- Fix browser tab title — already says "AI Creators" in `index.html`, but double-check after merge.

---

## B. Public landing page at `/`

**Routing change** (`src/App.tsx`):
- `/` no longer redirects unauthenticated visitors to `/login`. Instead, the new `Landing` component is the public route.
- If the visitor IS authenticated, `Landing` itself redirects to `/dashboard` (or `/admin/dashboard` for admins) via a small effect using `useAuth`.
- `Login` and `Signup` stay as their own dedicated pages.

**RLS adjustment** (new migration):
- Add a public-anon SELECT policy on `courses` (`published = true`), `modules`, and `lessons` (`published = true`) so the landing page's curriculum accordion can read them without auth. Current policies require `authenticated`; we'll add an `anon`-friendly policy that only exposes published rows.

**`src/pages/Landing.tsx`** — new file, single long-scroll page with these sections:

1. **Sticky nav** — transparent at top, white-with-blur after 40px scroll (use a `useEffect` scroll listener + class toggle). Brand mark + wordmark left, anchor links (Curriculum / Instructor / Pricing / FAQ) center, "Sign in" outline + "Start free →" primary right.
2. **Hero** (60vh desktop, stacks on mobile) — two columns. Left: serif H1 with italic teal "with AI" span, subhead, two CTAs, trust row (4 stacked avatar circles + placeholder "1,247 creators · 4.9/5"). Right: 5/4 aspect art card with teal→deep-teal-black gradient, saffron radial glow, large play button, "Sample lesson · 8 min" badge. Faint 8-pointed suzani star SVG behind the H1 at 7% opacity (inline SVG component).
3. **Trust bar** — thin row with "1,247 creators · 4.9/5 rating · 30+ countries" stat strip, hairline dividers.
4. **Outcomes** (`#outcomes`) — serif heading "By the end, you will:", 3-column grid of cards (Ship a mini-film / Build a recognizable style / Turn skill into income), each with teal-tinted icon square.
5. **Curriculum** (`#curriculum`) — serif heading + sub. 5 accordion cards driven from a `supabase.from('modules').select('*, lessons(...)').eq('course_id', defaultCourseId)` call. First module open by default. Reads live from DB (uses the new anon RLS).
6. **Instructor** (`#instructor`) — two-column. Bio + photo pulled from `platform_settings` keys (`landing.instructor.bio`, `landing.instructor.photo_url`) with sensible defaults if missing. Photo: circular 240px with teal ring shadow.
7. **How it works** — 3 numbered steps (big serif teal numerals), each with H4 + 1-sentence body + small UI screenshot placeholder (use `/placeholder.svg` for now).
8. **Student showcase** (`#showcase`) — horizontal-scroll carousel (CSS `snap-x` with `overflow-x-auto`) of 6 cards. Seed with 6 Unsplash placeholder URLs. Cards loaded later from a new `showcase` storage bucket via admin.
9. **Pricing** (`#pricing`) — single centered card "AI Creators · Full Course · Free for now" with 6 checkmark items + primary CTA. Note about premium tier coming soon.
10. **FAQ** (`#faq`) — 8 accordion items, defaults hardcoded (admin-editable in v1.6 but stored in `platform_settings.landing.faq` already so the editor in section D works).
11. **Final CTA** — full-width darker cream band, serif H2, sub, big primary button.
12. **Footer** — 3 columns (collapses to 1 on mobile): brand+social / nav links / legal+contact. Bottom strip "© 2026 AI Creators · Made in Tashkent".

Smooth-scroll anchors via `scroll-behavior: smooth` on `html` (add to `index.css`) plus `id` attributes on each section.

---

## C. Student dashboard upgrades (`src/pages/Dashboard.tsx`)

**1. Hero "Today's lesson" card** — full-width card at top (above the existing course list):
- Cover thumbnail strip (130px tall) using `next.lessons.thumbnail_path` if present, else a teal gradient.
- Body: uppercase "Next up · Module {n}", serif H2 with the next incomplete lesson title, 1-line description, progress bar + "X / Y lessons · Z% complete", primary "Continue learning →" + outline "Course page".
- Source: query the user's first incomplete lesson across their default-enrollment course (use existing logic in the `useEffect`, just surface the first row). If all 20 are complete → show a "Course complete 🎉" celebration card with "Browse other courses" CTA.

**2. Streak ring** — replace the simple chip on the top-right of the welcome row:
- 32px conic-gradient ring filled to weekly progress %, streak number inside (read from `streaks.current_streak`), then text "{N}-day streak · keep the momentum." If 0 → "Start your streak today".
- Pure-CSS conic gradient via inline `style={{ background: 'conic-gradient(...)' }}`.

**3. Weekly side card** — new right-column card (the dashboard becomes a 2-col grid `lg:grid-cols-[1fr_320px]` on the welcome row):
- Uppercase "This week" + serif H3 ("You're on pace" or "Behind by N").
- 3-col stat grid: lessons completed this week / hours watched / notes saved (computed from `lesson_progress` filtered by current ISO week + `lesson_notes` count).
- AI Study Assistant nudge box (soft-teal `bg-accent/40` card): "💡 AI Study Assistant" + tagline + "Ask now →" link to the most recent in-progress lesson page.

Existing course cards stay below this hero/sidebar block, untouched.

---

## D. Admin "Landing page" tab (`src/pages/admin/AdminSettings.tsx`)

Wrap the existing settings in shadcn `Tabs`: "Integrations" (current Telegram + AI + Content Protection cards) and a new **"Landing page"** tab.

New `LandingPageEditor` component:
- Hero headline (text input)
- Hero sub (textarea)
- Instructor bio (markdown textarea)
- Instructor photo upload → new `instructor` public storage bucket (created via migration). Show current image preview.
- FAQ items (sortable repeater: question + answer pairs, with add/remove/move-up/move-down buttons; stored as a jsonb array).
- Save button writes to `platform_settings` with keys: `landing.hero.headline`, `landing.hero.sub`, `landing.instructor.bio`, `landing.instructor.photo_url`, `landing.faq`.

Landing page reads each key with fallback defaults, so the page works fine before the admin ever touches it.

---

## E. Admin dashboard quick wins (`src/pages/admin/AdminDashboard.tsx`)

**1. Quick-action buttons** under the page title:
- "+ New course" → links to `/admin/courses` (which has the create flow).
- "+ Add user" → links to `/admin/users` and triggers the existing add-student modal via a query param (`?new=1`).
- "Import CSV" → same approach (`?import=1`).

**2. Trend deltas on the 4 stat cards** — extend the existing `load()` to also fetch the prior 30d window for each metric. Pass a `delta` prop to `StatCard` (e.g., `+12%` in teal, `−4%` in `text-destructive`). Compute as `(current - prior) / prior * 100`, rounded.

**3. At-risk chip card** — a 5th compact card to the right of the stat grid (or wraps to next row): red-bordered, count of students with no progress in 14+ days. Click expands the existing stuck students table (smooth-scroll + flash highlight). Compute by extending the existing stuck-students logic with a 14d threshold.

---

## F. Lesson player dark scope (`src/pages/LessonPage.tsx`)

Add a `useEffect` to mount/unmount `lesson-dark` class on `document.documentElement` for the lesson route only:
```ts
useEffect(() => {
  document.documentElement.classList.add('lesson-dark');
  return () => document.documentElement.classList.remove('lesson-dark');
}, []);
```
The `.lesson-dark` rule in `index.css` overrides the CSS vars to the dark teal palette. Existing lesson markup needs no JSX changes — Tailwind classes auto-pick up the new var values.

---

## G. Auth pages recolor (`src/pages/Login.tsx` `AuthShell`)

In the `AuthShell` component (used by Login + Signup + Forgot/Reset):
- Left dark panel: change `bg-foreground` to `bg-[#0E2A2A]` (deep teal-black) and add a faint suzani star pattern at low opacity for warmth.
- Right panel keeps the cream background (already inherits from `--background`).
- Brand mark uses the new logo style (teal square with white A).

---

## H. Migrations + storage

Single migration adds:
1. **Public-read RLS** on `courses` / `modules` / `lessons` for the `anon` role (only published rows for courses + lessons; modules readable for any published parent course).
2. **`instructor` storage bucket** (public) with admin-write + public-read policies.
3. **`showcase` storage bucket** (public) with admin-write + public-read policies (for v1.6 student showcase uploads — bucket created now so admin tab works).

No new tables — landing copy lives in the existing `platform_settings` jsonb table.

---

## File touch list

**New files**
- `src/pages/Landing.tsx`
- `src/components/landing/Nav.tsx`, `Hero.tsx`, `Outcomes.tsx`, `Curriculum.tsx`, `Instructor.tsx`, `HowItWorks.tsx`, `Showcase.tsx`, `Pricing.tsx`, `FAQ.tsx`, `FinalCTA.tsx`, `Footer.tsx`, `SuzaniStar.tsx` (small components for readability)
- `src/components/admin/LandingPageEditor.tsx`
- `public/favicon.svg`
- `supabase/migrations/<ts>_landing_public_rls_and_buckets.sql`

**Edited**
- `src/index.css` (theme vars + Fraunces import + lesson-dark scope + smooth scroll)
- `tailwind.config.ts` (serif font + gold color)
- `src/components/Layout.tsx` (new logo)
- `src/App.tsx` (route `/` → Landing)
- `src/pages/Dashboard.tsx` (hero + streak ring + weekly card)
- `src/pages/Login.tsx` (AuthShell teal recolor)
- `src/pages/admin/AdminSettings.tsx` (tabs + Landing editor)
- `src/pages/admin/AdminDashboard.tsx` (quick actions + trends + at-risk chip)
- `src/pages/LessonPage.tsx` (mount `.lesson-dark`)
- `index.html` (favicon link, drop the old .ico ref)

**Deleted**
- `public/favicon.ico`

---

## Out of scope (intentionally deferred to v1.6)

- Global dark-mode toggle.
- Wiring real "1,247 creators / 4.9 rating" stats — placeholder copy now, live counts later.
- Translating landing page into ru/uz (English only for v1.5, matching the rest of the marketing surface).
- Editable How-it-works copy in admin (hardcoded for v1.5).
- Live student showcase uploads (bucket exists, but UI to upload + reorder ships in v1.6; for now Unsplash placeholders).

---

## Self-test checklist (run after build)

1. Incognito → `/` shows landing (no `/login` redirect). All 12 sections render, anchor links smooth-scroll.
2. Click "Start free →" → `/signup` shows new teal AuthShell.
3. New student signup → `/dashboard` shows Today's-lesson hero + streak ring + weekly card in cream+teal.
4. Open a lesson → page switches to dark teal scope (deep teal-black bg, bright teal accents).
5. Admin → `/admin/dashboard` shows 3 quick-action buttons + trend deltas + at-risk chip.
6. Admin → `/admin/settings` → Landing page tab → change headline → save → refresh `/` → change visible.
7. Tab title says "AI Creators". Favicon is teal "A".
8. 375px viewport → hero stacks, FAQ accordion works, footer collapses to 1 column.