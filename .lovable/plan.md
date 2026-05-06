## Add "New Module" button to the Homework admin page

The Homework page at `/admin/homework` only shows cards for modules that already exist. Your course currently has 3 modules (M1–M3), so there's nowhere to attach homework for M4, M5, etc. We'll add an inline shortcut to create new modules right from the Homework page.

### What you'll see

- A new **"+ Yangi modul"** button at the top of the Homework page (next to the page title).
- Clicking it opens a small dialog asking for:
  - **Module title** (required)
  - **Course** (auto-selected if there's only one; dropdown if multiple)
- On save, the module is created with `position` = (max existing position + 1), and the page reloads so a new card appears with its own "+ Yangi vazifa" button.

### Technical details

- File edited: `src/pages/admin/AdminHomework.tsx`
  - Add `Dialog` state for "new module" creation.
  - Insert into `public.modules` with `{ course_id, title, position: nextPos }`.
  - Re-run `load()` after success.
- No DB schema or RLS changes needed (admins already have write access on `modules`).
- No changes to SAP/parent logic — the existing per-module "+ Yangi vazifa" button continues to handle parent homework creation.
