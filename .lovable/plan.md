# Make the entire UI multilingual

## Goal
Right now only Login, Signup, Forgot/Reset, Settings, Dashboard, Layout, NotFound use `useTranslation`. The rest of the app — including the public Landing page, the Lesson player, Course page, Quiz page, all `/admin/*` pages, `RequireAuth`, and the Telegram button — is hardcoded English. Switching the language has no effect on those screens.

We'll wire `useTranslation` everywhere and expand the three locale files (`uz.json`, `ru.json`, `en.json`) with all the missing keys. **Course content (titles, descriptions, transcripts, module/lesson names, instructor bio, admin-edited landing copy stored in `platform_settings`) stays untranslated** as you requested — that's user-generated/DB data.

## Scope of strings to translate

### 1. `src/pages/Landing.tsx` (the biggest gap — ~80 strings)
- Nav: "Curriculum / Instructor / Pricing / FAQ", "Sign in", "Start free"
- Hero: default headline, default sub, "Start learning free", "View curriculum", "Joined by 1,247 creators · 4.9/5 rating", "Sample lesson · 8 min"
- Trust bar: "creators / rating / countries / of curriculum"
- Outcomes section: heading "By the end, you will:", "Three concrete outcomes — not vague promises.", and the 3 cards (Ship a mini-film, Build a recognizable style, Turn skill into income) including bodies
- Curriculum section: "What you'll learn over 14 hours", "Five modules. Twenty lessons. Built to compound.", "lessons · X min", "Curriculum coming soon."
- Instructor section: "Meet your instructor", default bio fallback, "Built X · taught Y · shipped Z"
- How it works: "How it works" + 3 steps (Sign up free / Watch and take notes / Ship your first project) titles + bodies
- Showcase: "What our students build.", subtitle, the 6 placeholder names+types stay (those are seed data — but the "Module N" suffix should be translated)
- Pricing: "Start free. Upgrade when you're hooked.", "AI Creators · Full Course", "Free", "for now", the 6 feature bullets, "Premium tier coming soon · taught in English with Russian + Uzbek subtitles."
- FAQ: "Questions, answered." + the 8 `DEFAULT_FAQ` Q/A pairs (admin-edited FAQ from DB stays as-is)
- Final CTA: "Ready to start building?", "Free signup · 2 minutes · cancel anytime."
- Footer: "A 14-hour curriculum…", "Course / Company" headers, "Curriculum / Instructor / Pricing / FAQ / Sign in / Sign up / Contact", "© 2026 AI Creators · Made in Tashkent"

### 2. `src/pages/LessonPage.tsx`
- Breadcrumb "AI Creators" stays as brand, but separator/lesson title come from DB
- Buttons: "Prev", "Mark complete", "Next"
- Tabs: "Description / Notes / Bookmarks / Transcript"
- Notes panel: "Auto-saves as you type", "Insert timestamp", "Write your notes here…" placeholder
- Bookmarks: "Label (optional)" placeholder, "Add at current time", "No bookmarks yet."
- Transcript fallback: "Transcript not yet available for this lesson."
- Sidebar: "Course content", "Module N" label
- AI assistant: "AI Study Assistant", language-select labels (already a list — keep but localize header), empty state "Ask anything about this lesson. Try: …", quick-prompt chips ("Explain this", "3 practice questions", "Summarize", "I'm stuck"), "Ask the assistant…" placeholder
- Loading state "Loading…"
- Toasts: "Lesson marked complete", "AI tutor is busy, please try again.", "Retry"
- "_(response interrupted)_" suffix
- Default bookmark label "At m:ss" → keep numeric, just localize "At"

### 3. `src/pages/CoursePage.tsx`
- "← Dashboard" back link
- "Course not found."
- "Module N" label, "Take module quiz →"
- Sidebar: "Your progress", "Continue", "View certificate"
- Stat labels: "modules / lessons / total"

### 4. `src/pages/QuizPage.tsx`
- "← Back", "Quiz: {title}", "Pass with 80% or higher."
- "Submit answers", "Try again", "Back to course"
- Toasts: "Passed with X%!", "X% — need 80% to pass"

### 5. `src/components/RequireAuth.tsx`
- "Loading…" full-screen state

### 6. `src/components/TelegramLoginButton.tsx`
- `TG_NOT_CONFIGURED_MSG` ("Telegram login isn't configured yet…")
- "Popup blocked — please allow popups for this site."
- "Telegram sign-in cancelled."
- Default `fallbackLabel` "Telegram Bilan Kirish" — switch from a hardcoded Uzbek default to the translated key (so Russian/English users see the right label, while Uzbek still says "Telegram Bilan Kirish")

### 7. `src/pages/admin/*` (8 files)
All admin chrome — page titles, table headers, button labels, empty states, form labels, toasts, tab names — get translated under a new `admin.*` namespace (e.g. `admin.dashboard.title`, `admin.users.invite`, `admin.courses.newCourse`, `admin.settings.tabs.landing`, etc.). Course/module/lesson titles fetched from the DB inside the editors stay untranslated. I'll do an audit pass file-by-file and add keys for every visible string.

### 8. `index.html`
- `<html lang>` attribute — keep `en` (it'll change at runtime via JS once i18n loads, but a small enhancement: update `lang` from i18n on language change). Title stays as "AI Creators — Build, ship, and monetize with AI" (brand tagline).

## Locale file growth
`uz.json`, `ru.json`, `en.json` will gain new sections (additive — existing keys untouched):
- `landing.*` (nav, hero, outcomes, curriculum, instructor, howItWorks, showcase, pricing, faq, finalCta, footer)
- `lesson.*` (extending existing `course.*` where overlap; new keys for breadcrumb, sidebar, AI assistant chips/empty/placeholder, toasts)
- `coursePage.*` (back, notFound, takeQuiz, progress, continue, certificate, stat labels)
- `quiz.*` extensions (backToCourse, passWith, needToPass, submitAnswers, tryAgain, passLine)
- `telegram.*` (notConfigured, popupBlocked, cancelled, defaultLabel)
- `admin.*` (sub-namespaced per page: dashboard, users, courses, courseEditor, settings, aiAnalytics, audit, deploy)
- `common.loading` already exists — reuse for RequireAuth

I'll write **all three languages at once** (Uzbek primary, then Russian, then English) so nothing is left in fallback.

## Code changes per file
For each file listed above:
1. Add `import { useTranslation } from "react-i18next"` and `const { t } = useTranslation();`
2. Replace every hardcoded string with `t("namespace.key")` or `t("...", { var })` for interpolations (e.g. lesson counts, percentages, names).
3. Keep DB-sourced strings (`lesson.title`, `course.title`, `m.title`, `l.title`, `copy.headline` from `platform_settings`, FAQ from DB) untouched.
4. For arrays of structured content (outcomes cards, how-it-works steps, default FAQ, pricing features), define them inside the component using `t()` so they re-render on language change.

## Tiny enhancement
Update `<html lang>` reactively in `src/i18n/index.ts` (or via a small effect in `App.tsx`) so screen readers and search engines see the active language. Two-line addition.

## Out of scope (per your instruction)
- Course titles, lesson titles, lesson descriptions, transcripts, module names, quiz questions
- Admin-editable landing copy stored in `platform_settings` (hero headline override, instructor bio, FAQ items the admin enters)
- The 6 showcase student names (placeholder seed data)
- Toast messages from Supabase errors (those come from the backend)
- Email templates, edge function responses

## Verification
After the build I'll spot-check: switch language to Russian on the landing page, on a lesson page, on the admin dashboard, on the quiz page — confirm every visible UI label flips. Switch back to Uzbek, confirm the same.
