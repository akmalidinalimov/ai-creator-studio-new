# Fix student lesson UI: All modules button + My Settings menu

## What changes

### 1. Re-add "Barcha modullar" / "All modules" button — lesson page
On `src/pages/LessonPage.tsx`, restore the button between **Oldingi** and **Tugatildi** in the action row. It links to `/course/${courseId}` (the module list page) and uses the `LayoutList` icon. Same mobile-friendly styling as the other buttons (`w-full sm:w-auto min-h-[44px]`).

Final button order on a lesson:
```
Oldingi  |  Barcha modullar  |  Tugatildi  |  Keyingi
```

The `t("lesson.allModules")` translation key already exists in uz/en/ru — no i18n changes needed.

### 2. Fix "My Settings" (and other) avatar-menu items
On `src/components/Layout.tsx`, the avatar dropdown items currently call `navigate(...)` from inside Radix's `onClick`. In some browsers the dropdown's focus/close animation swallows the click before navigation runs, so tapping "My Settings" appears to do nothing.

Switch every `DropdownMenuItem` that navigates to use `asChild` + a real `<Link>`. This is the Radix-recommended pattern: the link element receives the click directly, navigation always fires, and middle-click / open-in-new-tab also work.

Affected items (student + admin):
- My Settings → `/settings`
- Dashboard → `/dashboard`
- Admin Dashboard, Courses, Users, Settings, AI Analytics, Audit, Deploy

Sign Out stays as-is (it runs an async action, not navigation).

## Technical notes
- No new dependencies, no DB changes, no i18n changes.
- No changes to the Settings page itself, the Bunny iframe, or the lesson editor.
- Files touched: `src/pages/LessonPage.tsx`, `src/components/Layout.tsx`.

## Verify after deploy
- On any lesson (e.g. `/lesson/c8103dae.../8a0f67d0...`) the action row shows 4 buttons including **Barcha modullar**, which routes to the course module list.
- Click avatar → **My Settings** → lands on `/settings` reliably on desktop and mobile.
