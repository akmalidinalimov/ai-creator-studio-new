## Goal
Fix the Telegram resubmission error and update two strings in the homework module flow.

## Root cause of "Qayta topshirish boshlab bo'lmadi"
`start_homework_resubmission` requires `auth.uid()` to be non-null and to match the row's user (or be teacher/admin). The Telegram bot calls it with the **service-role** Supabase client, where `auth.uid()` is NULL → the function raises `not_authenticated` → bot shows the error toast.

## Changes

### 1. Database migration — fix the RPC
Replace `start_homework_resubmission` so service-role callers (the bot) bypass the per-user auth check, while web callers (students/teachers) keep the same authorization rules:

```sql
-- inside the function, replace the auth block:
IF auth.role() = 'service_role' THEN
  -- bot/edge-function context: trust the caller
  NULL;
ELSE
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_caller <> v_row.user_id
     AND NOT public.has_role(v_caller, 'teacher'::app_role)
     AND NOT public.has_role(v_caller, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
END IF;
```

Everything else (snapshot → archive → clear score → bump `attempt_number` → audit log) stays the same. `homework_submissions_guard` already permits the clear because `attempt_number` increases.

### 2. Telegram bot strings (`supabase/functions/telegram-bot-webhook/index.ts`)
At the module-task list (around line 3531):
- Header: `📝 M${modulePos} — ${moduleTitle}` → `📝 ${modulePos}-MODUL — ${moduleTitle}`
- Body: `Qaysi vazifani topshirasiz?` → `Vazifani qayta topshirish uchun, pastdagi tugmalardan birini bosib, topshiring`

(No other locales touched; this view is Uzbek-only today.)

### 3. Resubmission flow (no code change needed — verify only)
After `hw:resub_yes` succeeds, the bot already calls `startHomeworkIntent(...)`, which is the exact same path used for first-time submissions:
- shows the topic deeplink button → student uploads in the group topic → existing auto-detect path inserts a fresh `homework_submissions` row update + sends the student a "Vazifa qabul qilindi" confirmation + notifies teachers via `notify-homework-submission`.

So once the RPC stops erroring, resubmission rides on the existing, working pipeline — no duplicate notification logic to add.

## Files touched
- `supabase/migrations/<new>.sql` — replace `start_homework_resubmission`
- `supabase/functions/telegram-bot-webhook/index.ts` — two-line copy change at the module task list

## Out of scope
No changes to `homework_submissions_guard`, RLS, web UI (`HomeworkSection.tsx`, `TeacherHomework.tsx`), grading logic, or notification edge functions.