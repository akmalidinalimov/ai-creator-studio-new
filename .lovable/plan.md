## Audit: everything that scales with module/homework count

I've audited the whole codebase. Good news: almost every module-dependent surface is **already dynamic** — it iterates over the `modules` table at render time, so adding M4, M5, M6+ via the new "Yangi modul" button will automatically grow these UIs and flows. Below is the inventory plus the few small polish items I'd add.

### Already dynamic (no change needed)

| Surface | File | Notes |
|---|---|---|
| Edit Group dialog → "Modul N — … topiki" inputs | `src/pages/admin/AdminGroups.tsx` (L473) | `modules.map((m, i) => …)` |
| Group Topics collapsible card | `src/components/admin/GroupTopicsSection.tsx` (L105) | Same pattern + "X/Y sozlangan" counter |
| Admin Homework page (one card per module + SAPs) | `src/pages/admin/AdminHomework.tsx` | Just fixed |
| Course page modules list | `src/pages/CoursePage.tsx`, `src/pages/Landing.tsx` | Maps over modules |
| Student profile homework totals | `src/components/HomeworkProfileSection.tsx` | Aggregates by `module_id`, no fixed count |
| Telegram bot `/vazifalar` menu (one button per module → SAP submenu) | `supabase/functions/telegram-bot-webhook/index.ts` (L1095–1136, L1998–2018) | Dynamic |
| Auto-routing submission → next ungraded SAP | `homework-routing.ts` + bot webhook | Dynamic |
| Module-complete celebration nudge | `supabase/functions/notify-completion/index.ts` (L101–184) | Computes `module_number = position + 1` |
| Engagement detection / cron | `supabase/functions/cron-engagement/index.ts`, `detect-and-nudge` | Iterates real `modules` rows |
| Course editor (drag/drop modules) | `src/pages/admin/AdminCourseEditor.tsx` | Already dynamic |

### Hard-coded references to clean up (small polish)

These are cosmetic strings or test fixtures that mention "3 modul" / "M3" but don't break behavior. We should fix them so M4+ doesn't look orphaned in copy:

1. **i18n string** `src/i18n/locales/uz.json` line 297 — "3-modul yakunida sizning tayyor filmingiz bo'ladi." Replace with a generic "kurs yakunida…" phrasing (and the RU/EN equivalents if present).
2. **Funnel analytics label** `src/pages/admin/AnalyticsFunnel.tsx` line 13 — `finished_m3: "3-modulgacha yetdi"`. The funnel is hard-coded to 3 stages. Make it dynamic by querying `count(*) from modules where course_id = …` and rendering one funnel step per module ("M{n}gacha yetdi").
3. **Notifications preview default** `src/pages/admin/AdminNotifications.tsx` line 79 — `module_number: 2` is just a sample value for the template preview; fine to leave, but I'll add a short comment so it's not mistaken for a limit.

### What I'll change (small set)

```
src/i18n/locales/uz.json          # generic copy instead of "3-modul"
src/i18n/locales/ru.json          # same
src/i18n/locales/en.json          # same
src/pages/admin/AnalyticsFunnel.tsx  # dynamic per-module funnel steps
```

No DB migrations, no edge function changes, no schema work. Everything else already adapts to N modules automatically.

### How to verify after the change

1. In `/admin/homework`, click **"+ Yangi modul"** and add a 4th module.
2. Open `/admin/groups` → Edit any group → confirm a 4th "Modul 4 — … topiki" input appeared.
3. Open the bot `/vazifalar` — confirm the new module shows up as its own button (only after you add at least one active assignment to it).
4. In `/admin/analytics/funnel`, confirm a new "M4gacha yetdi" stage appears.
