# AI Creators Redesign — Plan 1: Foundation + Student Experience

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the student-facing app (Telegram Mini App + web, shared components) to the approved **Graphite & Emerald** design — new tokens, fonts, app shell, component library, and all student screens + real-world states — using existing data, without disrupting the working app.

**Architecture:** One shared design system on the existing React 18 + Vite + Tailwind + shadcn/ui stack. Tokens live in `src/index.css` (light `:root` + dark `.dark`); components read tokens via Tailwind's `hsl(var(--x))`. The Telegram vs web difference is only *chrome* (the shipped `src/lib/telegram/*` shell provides BackButton/viewport/theme). Screens are rebuilt to match the committed mockup, reusing each page's current data fetching. This plan is **frontend only** — the in-app homework *upload*, achievements *rendering*, and admin panel are follow-on plans (see end).

**Tech Stack:** React 18, Vite, TypeScript, Tailwind, shadcn/ui (Radix + `class-variance-authority`), `lucide-react`, `react-router-dom`, `@tanstack/react-query`, `react-i18next`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-17-ui-redesign-design.md`
**Visual source of truth:** `docs/redesign/mockup.html` (open in a browser; screens are `data-screen="…"`). Certificate template: `docs/certificate/`.

## Global Constraints

- **Palette = Graphite & Emerald** (spec §2.1). Dark tokens are the premium look; a clean light mode is defined. **Coral `--accent` is the single primary action per screen; emerald `--primary` carries gamified energy; green stays off the neutral canvas/tiles.**
- **Fonts:** Onest (UI) + Unbounded (big numbers/headlines) + Playfair Display (certificate only, not in this plan). Self-hosted `@font-face`, never a font CDN.
- **XP model (spec §7), never conflate:** **Umumiy XP** (total, drives tier) · **Haftalik XP** (weekly goal, resets Mon) · **Guruh reytingi XP** (`user_group_rating_xp`, leaderboard only). Leaderboard uses `user_group_rating_xp`, **never** `user_course_xp` (see memory xp-ranking-primitive).
- **Accessibility:** text on tints uses the `--*-2` contrast tokens (≥4.5:1); status is never color-only; tap targets ≥44px; visible focus; honor `prefers-reduced-motion`.
- **i18n:** all copy via `react-i18next` (uz/ru/en); numbers via i18n formatting, never hardcoded; layouts absorb ~30% Russian expansion (esp. the 5 tab labels).
- **Non-disruptive:** the existing app keeps working after every task; tokens change values not structure; nothing merges to `main` without the owner's explicit "merge it".
- **Verification convention (frontend):** every task ends by running `npm run typecheck` (**must be clean — Vite build skips tsc**, see memory frontend-typecheck-verify) and `npm run build`, then **visually comparing the built screen against the matching `docs/redesign/mockup.html` screen in light + dark**. Cast untyped Supabase tables/RPCs as `.from("t" as any)` / `.rpc("fn" as any)`. Pure helpers get a `vitest` unit test (`npm test`).

---

## File structure

**Foundation**
- `public/fonts/{Onest,Unbounded}[wght].ttf` — created (self-hosted variable fonts).
- `src/index.css` — modified: `@font-face`, Graphite & Emerald tokens (light + dark), gloss/shadow vars, keep existing utility classes.
- `tailwind.config.ts` — modified: `fontFamily` (Onest/Unbounded), confirm token mapping + radius.
- `index.html` — modified: drop the Clash/Inter/Fraunces `<link>`s.
- `src/lib/telegram/appShell.ts` — created: `applyTelegramChrome(webApp)` (header/background color + brand-theme enforcement); complements the shipped `theme.ts`/`useTelegramViewport.ts`.
- `src/components/StudentBottomNav.tsx` — modified: 5 tabs Bosh/Darslar/Vazifa/Reyting/Profil + pending dot.

**Component library** (`src/components/ui-kit/`, new folder — keeps redesign primitives separate from vendored shadcn `ui/`)
- `Button.tsx`, `Card.tsx` (+`Hero`), `StatTile.tsx`, `Progress.tsx` (`Bar`,`Ring`,`TierBar`), `Gamify.tsx` (`XpPill`,`StreakChip`,`TierBadge`,`RewardChip`,`StatusChip`), `SectionHeader.tsx`, `ModuleRow.tsx`, `LessonRow.tsx`, `Skeleton.tsx`, `EmptyState.tsx`, `Celebrate.tsx`.
- `src/lib/xp.ts` — created: `tierFor`, `xpToNextTier`, `formatXp` (pure, unit-tested).

**Screens** (rebuild in place, reuse existing data)
- `src/pages/Dashboard.tsx` → Home (Bosh). New route + page `src/pages/Lessons.tsx` (Darslar), `src/pages/Homework.tsx` (Vazifa, read-only this plan).
- `src/pages/LessonPage.tsx`, `src/pages/Leaderboard.tsx`, `src/pages/Profile.tsx` — re-skinned.
- `src/App.tsx` — modified: add `/lessons`, `/homework` routes; redirect legacy `/badges`,`/activity` into Profil.
- `src/i18n/locales/{uz,ru,en}.json` — modified: new keys.

---

## PHASE 1 — Foundation

### Task 1.1: Self-host the fonts

**Files:** Create `public/fonts/Onest[wght].ttf`, `public/fonts/Unbounded[wght].ttf`. Modify `src/index.css`, `index.html`.

- [ ] **Step 1:** Download the variable fonts into `public/fonts/` (same sources used for the mockup):
```bash
mkdir -p public/fonts
curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/onest/Onest%5Bwght%5D.ttf" -o "public/fonts/Onest[wght].ttf"
curl -sL "https://raw.githubusercontent.com/google/fonts/main/ofl/unbounded/Unbounded%5Bwght%5D.ttf" -o "public/fonts/Unbounded[wght].ttf"
# sanity: both start with the TrueType magic 00 01 00 00
head -c4 "public/fonts/Onest[wght].ttf" | xxd
```
- [ ] **Step 2:** At the very top of `src/index.css` (replacing the `@import url('…fonts.googleapis…')` line on line 1), add self-hosted faces:
```css
@font-face{font-family:'Onest';src:url('/fonts/Onest[wght].ttf') format('truetype');font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:'Unbounded';src:url('/fonts/Unbounded[wght].ttf') format('truetype');font-weight:100 900;font-style:normal;font-display:swap}
```
- [ ] **Step 3:** In `index.html`, delete the three font `<link>` lines (fontshare Clash Display, Google Hanken/Inter, and the `preconnect`s to `api.fontshare.com`/`fonts.googleapis.com`/`fonts.gstatic.com`). Keep everything else.
- [ ] **Step 4:** Verify: `npm run typecheck && npm run build`. Open the app — text should render in a fallback until fonts wire in Task 1.2/1.3 (no error).
- [ ] **Step 5:** Commit.
```bash
git add "public/fonts" src/index.css index.html
git commit -m "feat(redesign): self-host Onest + Unbounded, drop font CDNs"
```

### Task 1.2: Graphite & Emerald tokens

**Files:** Modify `src/index.css` (the `:root` and `.dark` / global-dark token blocks), `tailwind.config.ts`.

**Interfaces — Produces:** CSS custom properties consumed everywhere as `hsl(var(--token))`: `--background --foreground --card --card-foreground --popover --popover-foreground --primary --primary-foreground --secondary --secondary-foreground --muted --muted-foreground --accent --accent-foreground --border --input --ring --gold` plus redesign additions `--surface-2 --tint --accent-soft --good --warning --danger --accent-2 --gold-2 --good-2 --danger-2 --shadow-soft --shadow-gloss`.

- [ ] **Step 1:** Replace the light `:root` token values (currently the Samarkand mint set, `src/index.css` ~lines 8–68) with the **light** Graphite & Emerald set. Values (convert each hex to `H S% L%`):
```
--background:#F2F4F3  --foreground:#0C2624  --card:#FFFFFF  --card-foreground:#0C2624
--popover:#FFFFFF --popover-foreground:#0C2624
--primary:#0F766E --primary-foreground:#FFFFFF   /* deep teal on light */
--secondary:#EDF0EE --secondary-foreground:#0C2624
--muted:#EDF0EE --muted-foreground:#5E7370
--accent:#FF6A4D --accent-foreground:#FFFFFF     /* coral CTA */
--border:#DDE9E5 --input:#DDE9E5 --ring:#0F766E
--gold:#E0A83C  --surface-2:#F5F8F6 --tint:#E7EEEC --accent-soft:#FFE6DF
--good:#0F9D6B --warning:#E0A83C --danger:#C0512D
--accent-2:#C93B22 --gold-2:#8F6410 --good-2:#0A7A55 --danger-2:#A53D1F
--shadow-soft:0 1px 2px hsl(180 50% 11% / .05),0 10px 30px hsl(174 40% 20% / .08)
--shadow-gloss:inset 0 1px 0 #00000000
```
- [ ] **Step 2:** Replace the global dark theme block (the `.dark{…}` and the lesson-page dark block, ~lines 70–130) with the **dark** Graphite & Emerald set (this is the premium look):
```
--background:#15191B --foreground:#EDF1F0 --card:#22282B --card-foreground:#EDF1F0
--popover:#22282B --popover-foreground:#EDF1F0
--primary:#2FE0B0 --primary-foreground:#06251E     /* emerald accent */
--secondary:#262D31 --secondary-foreground:#EDF1F0
--muted:#262D31 --muted-foreground:#9AA5A2
--accent:#FF6A4D --accent-foreground:#FFFFFF
--border:#2B3237 --input:#2B3237 --ring:#2FE0B0
--gold:#E6C877 --surface-2:#262D31 --tint:#242B2E --accent-soft:#3A1A13
--good:#34D399 --warning:#E6C877 --danger:#FF8C6B
--accent-2:#FF9178 --gold-2:#F0C869 --good-2:#34D399 --danger-2:#FF8C6B
--shadow-soft:0 1px 2px #00000066,0 18px 44px #00000073
--shadow-gloss:inset 0 1px 0 #ffffff12
```
- [ ] **Step 3:** In `tailwind.config.ts`, add `fontFamily: { sans: ['Onest','system-ui','sans-serif'], display: ['Unbounded','Onest','sans-serif'] }` and confirm the `colors` map already exposes `accent`, `border`, `gold`, etc. via `hsl(var(--x))`. Add `boxShadow: { soft: 'var(--shadow-soft)', gloss: 'var(--shadow-gloss)' }`.
- [ ] **Step 4:** In `src/index.css` `@layer base`, set `body{ font-family: 'Onest', system-ui, sans-serif }`. Keep any existing `.animate-fade-in` etc.
- [ ] **Step 5:** Verify: `npm run typecheck && npm run build`. Open the app in **both** light and dark (toggle) — the whole existing UI should adopt graphite/emerald with no broken contrast; check `/dashboard`, `/login`, an admin page.
- [ ] **Step 6:** Commit. `git commit -am "feat(redesign): Graphite & Emerald token system (light + dark)"`

### Task 1.3: Telegram app-shell chrome

**Files:** Create `src/lib/telegram/appShell.ts`. Modify `src/lib/telegram/TelegramGate.tsx` (call it after auth).

**Interfaces — Consumes:** `TgWebApp` from `src/lib/telegram/types.ts`. **Produces:** `applyTelegramChrome(webApp: TgWebApp): void`.

- [ ] **Step 1:** Create `src/lib/telegram/appShell.ts`:
```ts
import type { TgWebApp } from "./types";
/** Match Telegram's native header/background to the brand ground so its chrome doesn't clash. */
export function applyTelegramChrome(webApp: TgWebApp): void {
  const isDark = document.documentElement.classList.contains("dark");
  const bg = isDark ? "#15191B" : "#F2F4F3";
  try { (webApp as any).setBackgroundColor?.(bg); } catch { /* older client */ }
  try { (webApp as any).setHeaderColor?.(bg); } catch { /* older client */ }
}
```
- [ ] **Step 2:** In `TelegramGate.tsx`, after `setSession` succeeds and after `applyTelegramTheme(webApp)` runs, call `applyTelegramChrome(webApp)`; also re-run it inside the existing `themeChanged` subscription.
- [ ] **Step 3:** Extend `src/lib/telegram/types.ts` `TgWebApp` with `setHeaderColor?(c:string):void; setBackgroundColor?(c:string):void;` (optional — older clients lack them).
- [ ] **Step 4:** Verify: `npm run typecheck && npm run build`. (Device check of header color is owner-gated — note it, don't block.)
- [ ] **Step 5:** Commit. `git commit -am "feat(miniapp): match Telegram header/background to the brand ground"`

### Task 1.4: Bottom nav → 5 redesign tabs

**Files:** Modify `src/components/StudentBottomNav.tsx`. Depends on routes added in Task 2.2/2.6 (`/lessons`, `/homework`) — until those exist the tabs render but two 404 to NotFound; that's fine mid-plan and resolved by Phase 2.

- [ ] **Step 1:** Replace the `tabs` array with: Bosh `/dashboard` (Home icon), Darslar `/lessons` (BookOpen), Vazifa `/homework` (ClipboardCheck), Reyting `/leaderboard` (Trophy), Profil `/profile` (User, also matches `/settings`,`/badges`,`/activity`). Import the new icons from `lucide-react`.
- [ ] **Step 2:** Add a **pending dot** on the Vazifa tab: accept an optional `pendingHomework?: boolean` via a lightweight `usePendingHomework()` hook (a `@tanstack/react-query` count of the student's ungraded submissions — reuse the query already used on the current homework message; return `count > 0`). Render an emerald `--primary` 8px dot at the icon's top-right when true.
- [ ] **Step 3:** Keep `paddingBottom: env(safe-area-inset-bottom)`. Bump the label size to `text-[11px]` and verify all five fit at 320px width in **Russian** (Bosh/Darslar/Vazifa/Reyting/Profil → Главная/Уроки/Задание/Рейтинг/Профиль); if a label overflows, use the shorter Russian variant, don't shrink below 10px.
- [ ] **Step 4:** Verify: `npm run typecheck && npm run build`; open `/dashboard` on a narrow viewport in uz + ru, compare the tab bar to the mockup's phone tabs.
- [ ] **Step 5:** Commit. `git commit -am "feat(redesign): 5-tab bottom nav (Bosh/Darslar/Vazifa/Reyting/Profil) + pending dot"`

### Task 1.5: Component library (`ui-kit`) + XP helper

**Files:** Create `src/lib/xp.ts`, `src/lib/xp.test.ts`, and `src/components/ui-kit/*` (list above).

**Interfaces — Produces:**
- `xp.ts`: `tierFor(totalXp:number): {key:'bronze'|'silver'|'gold'|'platinum'|'diamond'; name:string; min:number; next:number|null}`; `xpToNextTier(totalXp:number): number|null`; `formatXp(n:number, locale:string): string`.
- `ui-kit`: `<Button variant primary|secondary|ghost size sm|md block>`, `<Card>`,`<Hero>`, `<StatTile icon label value highlight?>`, `<ProgressBar value>`,`<ProgressRing pct size>`,`<TierBar pct>`, `<XpPill>`,`<StreakChip days>`,`<TierBadge tier>`,`<RewardChip>`,`<StatusChip kind='ok'|'wait'|'redo' label>`, `<SectionHeader title action?>`, `<ModuleRow state='done'|'active'|'locked' n title meta lockReason? onClick?>`, `<LessonRow state title meta here?>`, `<Skeleton>`,`<EmptyState icon title body cta?>`,`<Celebrate emoji title body xp?>`.

- [ ] **Step 1: Write the failing test** `src/lib/xp.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tierFor, xpToNextTier } from "./xp";
describe("tiers (0/300/600/1000/1500)", () => {
  it("840 XP is Gold, 160 to Platinum", () => {
    expect(tierFor(840).key).toBe("gold");
    expect(xpToNextTier(840)).toBe(160);
  });
  it("0 XP is Bronze; 1500+ is Diamond with no next", () => {
    expect(tierFor(0).key).toBe("bronze");
    expect(tierFor(1600).key).toBe("diamond");
    expect(xpToNextTier(1600)).toBeNull();
  });
});
```
- [ ] **Step 2:** Run `npm test -- xp` → FAIL (module not found).
- [ ] **Step 3:** Implement `src/lib/xp.ts` with the ladder from spec §7:
```ts
const TIERS = [
  { key:"bronze",   name:"Bronza",  min:0 },
  { key:"silver",   name:"Kumush",  min:300 },
  { key:"gold",     name:"Oltin",   min:600 },
  { key:"platinum", name:"Platina", min:1000 },
  { key:"diamond",  name:"Olmos",   min:1500 },
] as const;
export function tierFor(totalXp:number){
  let i=0; for(let k=0;k<TIERS.length;k++) if(totalXp>=TIERS[k].min) i=k;
  const next = TIERS[i+1]?.min ?? null;
  return { ...TIERS[i], next };
}
export function xpToNextTier(totalXp:number){ const n=tierFor(totalXp).next; return n===null?null:n-totalXp; }
export function formatXp(n:number, locale:string){ return new Intl.NumberFormat(locale==="en"?"en-US":locale==="ru"?"ru-RU":"uz-UZ").format(n); }
```
- [ ] **Step 4:** Run `npm test -- xp` → PASS.
- [ ] **Step 5:** Build the `ui-kit` components. Each maps a mockup class group to a token-driven component using `class-variance-authority` (follow the pattern in `src/components/ui/button.tsx`). The exact visuals (radius, gradients, gloss, coral discipline) are in `docs/redesign/mockup.html` — read the `.card/.hero/.stat/.btn/.prog/.ring/.tierbar/.streak/.rewardchip/.hstat/.mod/.lessonrow/.slab/.frbox/.celebrate` CSS and reproduce with Tailwind + tokens. `Button` `primary` = `bg-accent text-accent-foreground` (the one CTA), `secondary` = `bg-primary text-primary-foreground`, `ghost` = `bg-[hsl(var(--tint))]`; all `min-h-[44px]`. `StatusChip` text uses the `--*-2` tokens. Cards use `shadow-soft` + `shadow-gloss` and the dark glossy gradient.
- [ ] **Step 6:** Verify: `npm run typecheck && npm run build`; drop the components on a throwaway `/kit` route (or Storybook-less scratch page) and eyeball against the mockup in light + dark. Remove the scratch route before commit.
- [ ] **Step 7:** Commit. `git add src/lib/xp.* src/components/ui-kit && git commit -m "feat(redesign): ui-kit primitives + XP/tier helper (tested)"`

---

## PHASE 2 — Student screens

> Each screen task: **rebuild the page's JSX** to match `docs/redesign/mockup.html` (`data-screen="…"`) using the `ui-kit`, **reuse the page's existing data fetching** (don't add new queries unless noted), keep all routes/RLS/i18n intact, then run the verification convention (typecheck + build + visual compare, light + dark). Add i18n keys to all three locales as you go.

### Task 2.1: Home (Bosh) — `data-screen="home"` + `"home-empty"`

**Files:** Modify `src/pages/Dashboard.tsx`. Add `miniapp.*`/`home.*` i18n keys.

- [ ] **Step 1:** Rebuild Dashboard to the mockup Home: greeting + streak chip + tier reward chip; **Continue-learning hero** (current module/lesson + progress + coral "Davom etish" → `/lesson/:courseId/:lessonId`); 4 stat tiles (**Umumiy XP** = total, Daraja = level, Reyting = group rank, Nishon = badge count); weekly-goal `ProgressRing` (**Haftalik XP** / target); a **homework status card** (counts from `usePendingHomework` + graded avg) → `/homework`; a compact course card → `/lessons`. Use `tierFor(totalXp)` for the tier chip/label.
- [ ] **Step 2:** First-run/empty (`home-empty`): when the student has 0 progress (no `xp` / no completed lessons), render the `EmptyState` "Keling, boshlaymiz!" with a coral "Birinchi darsni boshlash" CTA and a 0% ring, per the mockup. Branch on the existing progress data.
- [ ] **Step 3:** Wire all numbers through `formatXp(n, i18n.language)`; ensure total-XP vs weekly-XP come from the correct fields (spec §7) — do **not** show `user_group_rating_xp` here.
- [ ] **Step 4:** Verify (convention). Compare populated + first-run against the mockup.
- [ ] **Step 5:** Commit. `git commit -am "feat(redesign): Home (Bosh) dashboard + first-run state"`

### Task 2.2: Darslar (Lessons) — `data-screen="darslar"`

**Files:** Create `src/pages/Lessons.tsx`. Modify `src/App.tsx` (add `<Route path="/lessons" …>` behind `RequireAuth`). Reuse the course/module/lesson queries from `CoursePage.tsx`.

- [ ] **Step 1:** Build the module tree: course header + overall `ProgressRing`; a **"Qolgan joyingiz"** resume banner (current lesson) → `/lesson/...`; `ModuleRow` list (done/active/locked). The **active** module expands to its `LessonRow`s with the **"Shu yerda"** marker on the current lesson; **every** `ModuleRow` is tappable (done → open lessons to rewatch; locked → show `lockReason`, e.g. "🔒 N-modulni tugating").
- [ ] **Step 2:** Add the `/lessons` route and point the Darslar tab (Task 1.4) + Home's course card at it.
- [ ] **Step 3:** Verify (convention) against the mockup; check a locked module shows its reason and a completed module opens.
- [ ] **Step 4:** Commit. `git commit -am "feat(redesign): Darslar module/lesson browser"`

### Task 2.3: Lesson — `data-screen="lesson"`

**Files:** Modify `src/pages/LessonPage.tsx`. (Video already has `playsInline` — memory frontend-typecheck-verify / prior fix.)

- [ ] **Step 1:** Re-skin to the mockup Lesson: module/lesson caption (no in-app back button — Telegram's BackButton handles it via the shipped `useTelegramBackButton`; on web the top nav does), `ProtectedVideo`, title, a **+XP reward chip**, a steps checklist, a coral **"Uy vazifasini topshirish"** CTA (→ `/homework` this plan; the in-app upload flow is Plan 2), and a ghost **"Keyingi dars"** button.
- [ ] **Step 2:** Verify (convention). Confirm no duplicate back button inside Telegram.
- [ ] **Step 3:** Commit. `git commit -am "feat(redesign): Lesson screen"`

### Task 2.4: Reyting (Leaderboard) — `data-screen="reyting"`

**Files:** Modify `src/pages/Leaderboard.tsx`.

- [ ] **Step 1:** Rebuild to the mockup: Haftalik/Umumiy toggle, top-3 **podium**, then rows with the current user highlighted (`--accent-soft`), tier badges, and a "Top-3 gacha N XP" nudge. **Data must come from `user_group_rating_xp`** (memory xp-ranking-primitive), labelled "Guruh reytingi XP".
- [ ] **Step 2:** Edge cases: group with **<3 students** (podium renders 1–2 without breaking); a **sticky "your rank"** row pinned at the bottom when the user is outside the visible window; respect `hide_from_group_boards` (opted-out users already excluded server-side — keep it).
- [ ] **Step 3:** Verify (convention) incl. a tiny group.
- [ ] **Step 4:** Commit. `git commit -am "feat(redesign): Reyting leaderboard (podium + your-rank + small-group)"`

### Task 2.5: Profil (Profile) — `data-screen="profil"`

**Files:** Modify `src/pages/Profile.tsx`. Modify `src/App.tsx` (redirect legacy `/badges` and `/activity` → `/profile`). Reuse queries from `Profile.tsx`, `Badges.tsx`, `MyActivity.tsx`.

- [ ] **Step 1:** Rebuild to the mockup: avatar (existing upload stays), name, `@username`·group; 4 stat tiles; **tier progress** `TierBar` (`tierFor` → "Oltin", `xpToNextTier` → "Platinagacha N XP"); **earned-badges grid** from `user_badges`+`badges.icon`/`name_*` (display only this plan — download comes in Plan 3); streak; and settings rows (language, notifications, **Reytingda ko'rinish** board-visibility toggle calling the existing `set_board_visibility` RPC).
- [ ] **Step 2:** Fold in the content previously on `/badges` and `/activity` (badges grid + stats), then redirect those routes to `/profile` in `App.tsx` so the nav collapses to 5 tabs.
- [ ] **Step 3:** Verify (convention). Confirm the board-visibility toggle still writes.
- [ ] **Step 4:** Commit. `git commit -am "feat(redesign): Profil (tier, badges, stats, settings); fold /badges + /activity"`

### Task 2.6: Vazifa (Homework hub, read-only) — `data-screen="homework"`

**Files:** Create `src/pages/Homework.tsx`. Modify `src/App.tsx` (add `/homework`). Reuse the student-submissions query behind the current bot "Mening vazifalarim" flow.

- [ ] **Step 1:** Build the read-only hub: summary (BAHOLANDI / KUTILMOQDA / O'RTACHA), All/Waiting/Graded filter, and submission rows with `StatusChip` (**Baholandi + score / Kutilmoqda + "~24 soat" / Qayta yuboring**) + a graded-detail view (score, images if still present, teacher feedback, +XP). The **"Yangi vazifa topshirish"** button is present but, for this plan, links to the existing group-upload instruction (the in-app upload flow is **Plan 2**); the redo row's "Qayta yuklash" does the same.
- [ ] **Step 2:** Add the `/homework` route; point the Vazifa tab + Home homework card + Lesson CTA at it.
- [ ] **Step 3:** Verify (convention) against the mockup's `homework` + `hw-detail` screens.
- [ ] **Step 4:** Commit. `git commit -am "feat(redesign): Vazifa homework hub (read-only) + graded detail"`

### Task 2.7: Real-world states — skeletons, celebrations, error/offline

**Files:** Modify the five screens to use `Skeleton`/`EmptyState`/`Celebrate`; create nothing new.

- [ ] **Step 1: Loading skeletons** — replace each screen's loading branch with `ui-kit` `Skeleton` layouts matching the screen (Home hero+stats, Darslar rows, Reyting rows, Profil, Homework list). Cold Mini App start must never flash a blank/janky screen.
- [ ] **Step 2: Celebration moments** — a reusable `Celebrate` overlay for **lesson-complete (+XP)**, **module-complete**, **level-up**, **tier-up**; trigger from the existing completion/XP events (the same events that today fire toasts). Honor `prefers-reduced-motion` (no confetti/scale when set). *(Grade-received + submit-success celebrations arrive with Plan 2's upload flow.)*
- [ ] **Step 3: Error/offline** — a global `EmptyState`-style error block when a screen's query fails or the Mini App opens offline (retry button re-runs the query). Reuse the existing `ErrorBoundary`.
- [ ] **Step 4:** Verify (convention): throttle the network in devtools; confirm skeletons show, a forced query error shows the retry block, and a level-up fires the celebration (and is suppressed under reduced-motion).
- [ ] **Step 5:** Commit. `git commit -am "feat(redesign): loading skeletons, celebration moments, error/offline states"`

---

## Follow-on plans (write next, one at a time)

- **Plan 2 — In-app homework upload + hybrid retention:** the Upload flow (dropzone, camera/gallery/file, **client-side image compression**, thumbnails, uploading→success→error/offline queue), the backend that lands a submission in the **existing** homework tables/queues (SAP-step, idempotent XP, teacher DM/grade queue), and the retention reconciler (graded-+7d delete + `media_deleted_at` tombstone + course-deactivation purge + health signals). Spec §6.1–6.3, §6.6.
- **Plan 3 — Achievements rendering:** earned-badge **download** (re-fetch the Cloudinary card on demand) and the **certificate render** edge function (fill `docs/certificate/certificate-template.html` → HTML→PNG, à la `render-badge`) firing a **DM on module completion** + in-Profil download; nothing stored. Spec §6.4–6.5. (Owner owns the course-completion variant.)
- **Plan 4 — Admin/teacher redesign:** bespoke pass on the panels, on the same design system. Spec §9 Phase-2.

---

## Self-review

**Spec coverage:** §2.1 palette → T1.2 ✓; §2.2 fonts → T1.1/T1.2 ✓; §2.3 gloss → T1.2/T1.5 ✓; §3 components → T1.5 ✓; §4 shell → T1.3 + shipped `lib/telegram/*` ✓; §5 screens → T2.1–2.6 ✓; §5 states → T2.7 ✓; §7 XP model → `xp.ts` T1.5 + used in T2.1/2.4/2.5 ✓; §8 a11y/i18n → Global Constraints applied per task ✓; §9 rollout Phase-1 → this plan; Phases 2–4 → Follow-on plans ✓. **Deferred (correctly, to follow-on plans):** in-app upload + retention (§6.1–6.3), badge download + certificate render (§6.4–6.5), admin (§9 P2).
**Placeholder scan:** none — every code step has real content; screen tasks point at the committed mockup + named existing queries.
**Type consistency:** `tierFor`/`xpToNextTier`/`formatXp` signatures match between T1.5 definition and T2.1/2.4/2.5 usage; `applyTelegramChrome(webApp)` and `usePendingHomework()` consistent across tasks.
