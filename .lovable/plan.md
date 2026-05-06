## Root cause (confirmed from edge logs + DB introspection)

The edge function logs show the same error on every photo/video posted to a homework topic:

```
hw upsert error { code: "42703", message: 'record "new" has no field "awarded_at"' }
```

This is **NOT** in our edge function code. It is a **database trigger chain failure**:

1. Student posts in topic → edge function calls `homework_submissions.upsert(...)`.
2. `AFTER INSERT` trigger `trg_award_first_homework` fires → calls `award_badge()` → inserts into `public.user_badges`.
3. `AFTER INSERT` trigger `trg_queue_badge_dm` on `user_badges` fires → runs `queue_badge_dm()` which references **`NEW.awarded_at`**.
4. But `user_badges` columns are: `id, user_id, badge_id, earned_at`. There is no `awarded_at` column on that table → Postgres raises `42703`.
5. The error propagates back up, the entire `homework_submissions` insert is **rolled back**, the edge function returns the upsert error, and **nothing is saved, no student DM, no teacher DM, no ✅ reaction**.

So every prior fix (resolver, identity gate, dedupe, inbox) was correct in isolation — the database was silently rejecting every submission before the DM code path could even run.

## Fix (single migration, no edge function change needed)

Patch `public.queue_badge_dm()` so it reads from the actual `user_badges` column `earned_at` instead of the nonexistent `awarded_at`:

```sql
CREATE OR REPLACE FUNCTION public.queue_badge_dm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  tashkent_now timestamptz := now() AT TIME ZONE 'Asia/Tashkent';
  tashkent_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Asia/Tashkent'))::int;
  sched timestamptz := now();
  tashkent_today date := (now() AT TIME ZONE 'Asia/Tashkent')::date;
BEGIN
  IF tashkent_hour >= 22 OR tashkent_hour < 8 THEN
    IF tashkent_hour >= 22 THEN
      sched := ((tashkent_today + 1) + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    ELSE
      sched := (tashkent_today + time '08:00') AT TIME ZONE 'Asia/Tashkent';
    END IF;
  END IF;
  INSERT INTO public.badge_award_queue (user_id, badge_id, awarded_at, scheduled_for)
  VALUES (NEW.user_id, NEW.badge_id, COALESCE(NEW.earned_at, now()), sched);
  RETURN NEW;
END;
$function$;
```

Only `NEW.awarded_at` → `COALESCE(NEW.earned_at, now())`. Everything else identical. The destination column on `badge_award_queue` is still called `awarded_at`, so that stays.

## Why this fixes all three symptoms in one shot

- Submission row now persists → `homework_submissions` upsert succeeds.
- Edge function reaches `sendMessage(student.telegram_id, HW_STUDENT_CONFIRM[loc])` → student gets "Vazifangiz topshirildi" DM.
- Edge function reaches `sendMessage(teacher.telegram_id, ...)` with the Baholash inline button → teacher gets the notification.
- Bot debug page (`/admin/bot-debug`) will now show all 7 ticks green and `homework_detector_fired = true`.

## Scope-lock

- Only patches `queue_badge_dm()`.
- No edge function changes.
- No changes to `award_first_homework`, `user_badges`, `badge_award_queue`, `homework_submissions`, RLS, identity gate, resolver, or any UI.
- No frozen-version code (v3.14.10–v3.14.33) is touched.

## Verification after deploy

1. Have a student post a photo in a homework topic.
2. Open `/admin/bot-debug` — the new row should show all green ticks and `student_dm_sent: true`, `teacher_dm_sent: true`.
3. Confirm: student receives "Vazifangiz topshirildi" DM. Teacher receives DM with Baholash button.
4. Edge function logs should no longer contain `hw upsert error 42703`.

Commit label: **v3.14.34 — Fix queue_badge_dm referencing nonexistent NEW.awarded_at; restores homework submission persistence and student/teacher DMs.**
