## Audit Summary

I checked every Telegram notification path. Here's the full picture.

### What's working
- **Cron schedule**: A pg_cron job (`cron-engagement-every-30-min`, every 30 min) correctly invokes the `cron-engagement` edge function with proper auth headers. It's running on schedule.
- **Edge functions** themselves (`cron-engagement`, `notify-completion`, `telegram-bot-webhook`) are deployed and boot cleanly.
- **Templates** for all 8 notification types exist in all 3 locales (uz/ru/en).
- **User profiles** have `telegram_id` linked, `notifications_enabled = true`, valid timezone.
- **`telegram-bot-webhook`** (handles `/start`, language buttons, settings buttons) is wired correctly.

### What's broken

**1. Lesson/Module/Course completion notifications never fire (CRITICAL)**

The DB function `track_video_progress` is supposed to call `notify-completion` via HTTP when a lesson is first completed. The current code:

```sql
PERFORM extensions.http_post(
  url := edge_url,
  headers := jsonb_build_object('Content-Type', 'application/json'),
  body := jsonb_build_object('user_id', uid, 'lesson_id', p_lesson_id)
);
```

Two problems, compounding:
- `extensions.http_post` **does not exist**. `pg_net` exposes `http_post` only in the `net` schema. The call throws `function does not exist`, which is silently swallowed by `EXCEPTION WHEN OTHERS THEN NULL`.
- Even when fixed, the call is missing the `Authorization`/`apikey` headers that the Supabase edge function gateway requires.

**Evidence**: `notifications_log` has **0 rows total**. `notify-completion` edge function logs show **0 invocations ever**. Your completed lesson 1.4 has `completed_at` set in the DB, but no Telegram message was ever attempted.

This means **none** of these have ever fired:
- 🎬 Lesson complete
- 🎉 Module complete
- 🎓 Course complete (+ certificate + share image)

**2. Daily reminder / streak warning / re-engagement drip — likely never fired either**

`cron-engagement` runs every 30 min, but `notifications_log` is empty even for `daily_reminder`, `streak_warning`, `inactive_3/7/14`. The function code itself looks correct, so the most likely cause is a missing secret. We need to verify two env vars are set on edge functions:
- `TELEGRAM_BOT_TOKEN` — required to send any message; if missing, the function returns early with `"bot not configured"`
- `SITE_URL` — required to build magic-link URLs in buttons

If `TELEGRAM_BOT_TOKEN` is unset, every cron run silently no-ops. I'll verify this with `fetch_secrets` and add whichever is missing.

### Fix Plan

**Step 1 — Repair completion notifications (DB migration)**

Create a new migration that replaces `track_video_progress` so the HTTP call uses `net.http_post` with the project anon key as auth headers (mirrors how `cron-engagement` is invoked from cron):

```sql
PERFORM net.http_post(
  url := edge_url,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', '<anon key>',
    'Authorization', 'Bearer <anon key>'
  ),
  body := jsonb_build_object('user_id', uid, 'lesson_id', p_lesson_id)
);
```

Also: replace the silent `EXCEPTION WHEN OTHERS THEN NULL` with `RAISE WARNING` so future failures are visible in Postgres logs (still won't break the user's progress save).

**Step 2 — Verify edge-function secrets**

Use `fetch_secrets` to confirm `TELEGRAM_BOT_TOKEN` and `SITE_URL` are set on the functions runtime. If `TELEGRAM_BOT_TOKEN` is missing, request it from you. If `SITE_URL` is missing, set it to your published URL (`https://ai-creators-lesson.lovable.app`).

**Step 3 — Verify with a live test**

After the fix is deployed:
- Manually invoke `notify-completion` once for your already-completed lesson 1.4 so you receive the message you missed.
- Manually invoke `cron-engagement` once and confirm rows appear in `notifications_log` for any users in the reminder window.

### Files changed

- `supabase/migrations/<ts>_fix_track_video_progress_http.sql` — corrected `net.http_post` call with auth headers and visible warning on failure
- (No edge function code changes needed — the bug is entirely in the DB → edge HTTP plumbing.)
