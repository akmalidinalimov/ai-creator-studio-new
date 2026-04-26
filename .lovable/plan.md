
# Multilingual UI: Uzbek / Russian / English

Translate the **UI only** (buttons, menus, forms, toasts, validation messages, page copy). Course/lesson content stays in whatever language the admin entered.

## 1. i18n stack

- Add `i18next` + `react-i18next` + `i18next-browser-languagedetector`.
- Wrap the app in an `I18nProvider` mounted in `src/main.tsx` so translations are ready before any route renders.
- Languages: `uz` (default, fallback), `ru`, `en`.
- Detection order: user's saved choice (Supabase profile) → localStorage → browser → fallback to `uz`.

## 2. Translation files

Create `src/i18n/locales/{uz,ru,en}.json`, each split into namespaces for maintainability:

- `common` — buttons (Save, Cancel, Delete, Edit, Sign out…), generic words, time-ago strings
- `auth` — login, signup, forgot/reset password, magic link, lockout countdown, Telegram button label, "Add a passkey" toast
- `nav` — top-nav links, avatar menu items, admin nav
- `dashboard` — student dashboard ("Welcome back, {name}", course cards, progress)
- `course` — course page, module/lesson list, "Mark complete", "Next lesson"
- `lesson` — lesson page tabs (Description, Notes, Bookmarks, Transcript), AI assistant prompts, bookmark/timestamp buttons
- `quiz` — quiz UI, score, retry, pass/fail messaging
- `settings` — profile fields, password change, recent sign-ins, danger zone, **+ "Language" selector**
- `admin` — admin dashboard, courses, users (table headers including "Last name"), CSV import modal, audit log, AI analytics, deploy, settings
- `validation` — form errors ("Email is required", "Password too short", etc.)
- `toasts` — success/error toast messages

Uzbek is authored first (source of truth), then Russian and English. I'll translate the strings myself — no external translation API needed.

## 3. Language switcher (top nav)

Add a `LanguageSwitcher` component in `src/components/Layout.tsx` next to the avatar:

- Globe icon (`lucide-react` `Globe`) → `DropdownMenu` with three items: `O'zbekcha`, `Русский`, `English` (each shown in its own script).
- Current language gets a check mark.
- On select: `i18n.changeLanguage(code)` + write to `localStorage` + (if logged in) update `profiles.preferred_language`.
- Same switcher rendered on `/login`, `/signup`, `/forgot-password`, `/reset-password` (those pages don't use `Layout`, so add a small standalone variant in the top-right corner of the `AuthShell`).

## 4. Persistence

- New column: `profiles.preferred_language text default 'uz'` (migration).
- On `SIGNED_IN`, read `preferred_language` and call `i18n.changeLanguage()`.
- When changed while signed in, persist to `profiles`.
- When changed while signed out, persist to `localStorage` only.

The existing AI Study Assistant already has its own per-conversation language picker — leave it as-is, but seed its default from the user's UI language.

## 5. Component refactor

Replace hardcoded strings with `t('namespace.key')`:

- `src/components/Layout.tsx` (nav + avatar menu)
- `src/pages/Login.tsx`, `Signup.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`
- `src/pages/Dashboard.tsx`, `CoursePage.tsx`, `LessonPage.tsx`, `QuizPage.tsx`, `Settings.tsx`, `NotFound.tsx`
- `src/pages/admin/*` (Dashboard, Courses, CourseEditor, Users, Settings, AIAnalytics, Audit, Deploy)
- `src/components/admin/*` (LessonDrawer, ModuleQuizEditor, KnowledgeManager)
- `src/components/RequireAuth.tsx`, `TelegramLoginButton.tsx`, `lesson/ProtectedVideo.tsx`
- Toast call sites (most `toast({ title, description })` calls)

For dynamic strings with variables I'll use i18next interpolation (`t('dashboard.welcome', { name })`).

For pluralization (e.g. "1 lesson" / "5 lessons", "2 minutes ago"), use i18next's plural rules — Russian has 3 plural forms, Uzbek has 2, English has 2; i18next handles this natively per locale.

## 6. Out of scope (can be added later)

- **Course content translation** (titles, descriptions, transcripts, quizzes) — admins keep authoring in one language. We can add per-language fields or AI auto-translate in a follow-up.
- **Email templates** (welcome, magic link, password reset) — Supabase auth emails stay in the project's current template language for now. Custom emails sent by edge functions can be localized later if needed.
- **Date/number formatting** — I'll use `Intl.DateTimeFormat` with the active locale where dates are shown, but won't reformat every existing date display in this pass.

## 7. Files

**New**
- `src/i18n/index.ts` — i18next init
- `src/i18n/locales/uz.json`, `ru.json`, `en.json`
- `src/components/LanguageSwitcher.tsx`
- `supabase/migrations/<timestamp>_add_preferred_language.sql`

**Edited**
- `src/main.tsx` — import `./i18n`
- `src/contexts/AuthContext.tsx` — load `preferred_language` on sign-in
- `src/components/Layout.tsx` — mount switcher in nav
- All page/component files listed in §5 — swap hardcoded strings for `t(...)`
- `package.json` — add `i18next`, `react-i18next`, `i18next-browser-languagedetector`

## 8. Self-test after build

1. Fresh visit (no localStorage) → UI is in Uzbek.
2. Click globe → switch to Russian → every visible label changes; refresh → still Russian.
3. Sign in → switch to English → sign out → sign back in on a different browser → English persists (loaded from `profiles.preferred_language`).
4. Check `/login`, `/signup`, `/dashboard`, a `/course/:id`, a `/lesson/:id`, `/quiz/:id`, `/settings`, `/admin/users`, `/admin/audit` in all three languages — no leftover English strings, no overflow in narrow buttons.
5. Trigger a validation error and a success toast in each language — both translated.
6. Russian plurals render correctly for "5 уроков" vs "1 урок" vs "2 урока".
