## Goal
Replace every hardcoded English UI string in the `/admin/*` screens with `t()` translations across Uzbek, Russian, and English so the language switcher fully localizes the admin experience. Database-driven content (course titles, user names, audit JSON payloads, action keys, etc.) stays as-is.

## Scope — files to refactor

1. **`src/pages/Admin.tsx`** — Overview + Students tabs, stat cards, Add Student / CSV Import dialogs.
2. **`src/pages/admin/AdminDashboard.tsx`** — Stat cards, chart titles, "At-risk students" table, "Recent admin actions", quick-action buttons, trend deltas.
3. **`src/pages/admin/AdminCourses.tsx`** — Header, "New course" dialog, empty state, Draft/Published/Live/Hidden chips, lesson/hours labels, Edit button.
4. **`src/pages/admin/AdminCourseEditor.tsx`** — Course header fields, module/lesson controls, drag-and-drop hints, AI override card, cover upload labels.
5. **`src/components/admin/LessonDrawer.tsx`** — Tabs (Upload / Embed), upload progress states, transcript label, publish toggle, delete confirmation.
6. **`src/components/admin/ModuleQuizEditor.tsx`** — Dialog title, "Students need 80% to pass", option/explanation placeholders, Add question button.
7. **`src/components/admin/KnowledgeManager.tsx`** — Drop zone copy, status badges (pending/processing/ready/failed), re-index/delete tooltips, friendly error strings.
8. **`src/pages/admin/AdminUsers.tsx`** — Filters (status/role), table headers, Manage drawer (profile, role, status, courses, actions), confirm dialogs (promote/demote/delete), CSV template helper text.
9. **`src/pages/admin/AdminSettings.tsx`** — Telegram setup checklist, AI Assistant card, Content Protection toggles, Landing Page tab labels.
10. **`src/pages/admin/AdminAIAnalytics.tsx`** — Time-range select, stat card labels, chart titles, error table headers.
11. **`src/pages/admin/AdminAudit.tsx`** — Search placeholder, actor/date filters, ACTION_LABELS map, "time ago" suffixes, expand/collapse hints.
12. **`src/pages/admin/AdminDeploy.tsx`** — Step titles, tab labels (VPS/Vercel/Netlify/Cloudflare/Static), copy buttons, scaling notes.

## Locale changes

Expand the `admin.*` namespace in all three locale files (`en.json`, `ru.json`, `uz.json`) with sub-namespaces:

- `admin.common` — Save, Cancel, Delete, Edit, Add, Import, Export, Confirm, Search, Loading, Draft, Published, Live, Hidden, time ago units.
- `admin.dashboard` — already partly present; extend with quick actions, at-risk, trend deltas.
- `admin.courses` — list page + new course dialog.
- `admin.courseEditor` — module/lesson editor, AI override.
- `admin.lessonDrawer` — upload/embed/transcript/publish/delete.
- `admin.quiz` — module quiz editor.
- `admin.knowledge` — knowledge manager.
- `admin.users` — list, filters, manage drawer, dialogs, CSV helper.
- `admin.settings` — Telegram, AI assistant, content protection, landing tab.
- `admin.aiAnalytics` — stat + chart labels, error table.
- `admin.audit` — filters, action labels, expand details.
- `admin.deploy` — steps, platform tab labels, scaling notes.

All three languages written in the same pass so no key falls back to English.

## Implementation approach

- Add `import { useTranslation } from "react-i18next"` and `const { t } = useTranslation()` to each component listed above.
- Replace string literals (JSX text, `placeholder=`, `aria-label=`, `title=`, toast messages) with `t("admin.<section>.<key>")`.
- For arrays of strings (e.g. status options, action labels, deploy steps), define the array inside the component so it re-renders on language change.
- For toast messages tied to async operations, translate the user-visible string but keep the raw error message from the backend untranslated (it's already English from the API).
- Leave database-bound values (user emails, course titles, audit `target` values, action keys stored in DB) untranslated.

## Out of scope

- Backend-generated emails (welcome, magic link, reset password) — those live in Supabase email templates.
- Course/lesson/module titles and descriptions authored by admins.
- Audit log JSON payloads and raw `action` keys (only their human label via `ACTION_LABELS` map gets translated).
- Seed/sample data.

## Verification checklist

1. Switch language to RU and UZ on every admin route — no English remains except DB content.
2. Open every dialog/drawer (New course, Add student, Manage user, Lesson drawer, Module quiz, Confirm delete) in RU and UZ.
3. Trigger toast paths (save, delete, role change) and confirm the toast is translated.
4. AdminAudit ACTION_LABELS render in the active language.
5. AdminDeploy code snippets stay untranslated; only surrounding instructional copy translates.
6. `<html lang>` updates on switch (already implemented via `HtmlLangSync`).
