## Goal

In the teacher's Telegram bot keyboard, remove the **👥 Talabalar** button and move its functionality (the student roster → modules → grades drill-down) onto the existing **📝 Vazifalar** button. Also surface submission dates clearly in the drill-down view.

## Current state (verified in `supabase/functions/telegram-bot-webhook/index.ts`)

- **📝 Vazifalar** (`tKbHomework`) → maps to `/thomework` → calls RPC `admin_group_module_submissions` and shows per-module submitted/not-submitted aggregate buttons (lines 792, 1793–1825).
- **👥 Talabalar** (`tKbGraded`) → maps to `/baholar` → `renderTeacherRoster` → `tr:stu:<id>` → `renderStudentModules` → `tr:mod:<student>:<module>` → `renderStudentModuleDetail` (lines 790, 1993–1996, 2113–2270). This is the flow the user likes.
- Teacher keyboard has both on row 1 and row 2 (lines 686–687).

## Changes

### 1. Teacher keyboard — remove "Talabalar", keep "Vazifalar"
File: `supabase/functions/telegram-bot-webhook/index.ts`, function `getTeacherKeyboard` (lines 682–696).

Replace:
```
[{ text: t.tKbGrade }, { text: t.tKbGraded }],
[{ text: t.tKbStats }, { text: t.tKbHomework }],
```
with:
```
[{ text: t.tKbGrade }, { text: t.tKbHomework }],
[{ text: t.tKbStats }, { text: t.tKbTop }],
```
(and drop the now-duplicate `tKbTop` row below to keep layout clean — final row order: Grade+Homework, Stats+Top, Students+Inactive, Broadcast+Settings, Lang).

Admin keyboard (line 672) also references `tKbGraded`; replace with `tKbHomework` so admins keep access to the same roster flow when in teacher mode.

### 2. Reroute "📝 Vazifalar" → roster flow
File: same, button-to-command resolver (lines 770–800).

Change:
```ts
if (t.tKbHomework && trimmed === t.tKbHomework) return "/thomework";
```
to:
```ts
if (t.tKbHomework && trimmed === t.tKbHomework) return "/baholar";
```
Remove the `tKbGraded` resolver line (790) since the button is gone.

`/thomework` command handler (lines 1793–1825) stays in the file (still reachable via typed slash command) but is no longer wired to a keyboard button. No deletions needed — keeps backward compatibility.

### 3. Improve drill-down: show submission dates + latest grade per module
File: same, `renderStudentModules` (lines 2162–2214) and `renderStudentModuleDetail` (lines 2216–2270).

- In `renderStudentModules`: also select `submitted_at` and aggregate the **latest** `submitted_at` per module. Append it to the module-row button label or to a header line so the teacher sees "M1 — 2 ta · 8/10, 7/10 · 02-May".
- In `renderStudentModuleDetail`: prepend each task line with the formatted submission date, e.g. `• V1 — Title · 02-May 14:30 · 8/10`. Use existing `csvEscapeHtml` and a small `formatDate(submitted_at, locale)` helper (Tashkent offset already used elsewhere — reuse `formatTashkentDate` if present, otherwise inline `new Date(...).toISOString().slice(0,10)`).

No DB / RLS / RPC changes required — `homework_submissions.submitted_at` is already selected.

### 4. No schema, RLS, or web UI changes
Web `TeacherHomework.tsx` is untouched — this is bot-only.

## Out of scope

- `/thomework` aggregate view (kept reachable by typing the command, just unbound from the keyboard).
- Localization of new date strings beyond what's already in `T[locale]`.
- Resubmission flow, grading flow, notifications — unchanged.

## Files touched

- `supabase/functions/telegram-bot-webhook/index.ts` (keyboard rows, button resolver, two render functions).
