## Goal

Make the student `/Statistikam` (📊 Statistikam) numbers in the Telegram bot correct and unambiguous, and make sure the ranking line is fresh. Verify the teacher `/tstats` view is also correct (no fix needed if it already is).

## What's actually wrong (root cause analysis)

I checked the live database against the code in `supabase/functions/telegram-bot-webhook/index.ts → buildStatsMessage`:

1. **Lessons line: `📚 Darslar: 11/36 ko'rilgan`**
   - `36` is correct: there are exactly 36 published lessons in the default course "AI CREATORS" (4 modules).
   - `11` comes from `lesson_progress.completed_at IS NOT NULL` for that user. This is set by `track_video_progress` when the watched fraction crosses the completion threshold, plus a near-end fallback at `currentTime >= duration - 5s`, plus the manual "Mark complete" button.
   - The student's perception ("I didn't watch 11") is almost certainly because lessons get auto-completed when the player reaches the end (incl. quick scrubs to the end, autoplay through next videos, or earlier sessions they forgot). The number itself is what the database actually records.
   - **Fix:** add real evidence next to the count so the student trusts it: total minutes watched (from `daily_watch_summary.total_seconds`), e.g. `📚 Darslar: 11/36 ko'rilgan · 2h 14m jami`. No data change.

2. **Homework line: `📝 Uy vazifalari: 18/50 (o'rtacha 3.6/10)`**
   - This is the **biggest source of confusion**. Today the numerator/denominator are *points*, not assignment counts. A student naturally reads "18 of 50 homeworks". Real numbers from DB: 6 active homework rows, 1 is a parent container (Module 3), so **5 leaves** with `max_score=10` each → max 50 points. That matches what the bot shows.
   - **Fix:** show both axes explicitly:
     `📝 Uy vazifalari: 4/5 topshirildi · 18/50 ball (o'rtacha 3.6/10)`
     where `submitted = leaves with effective_score != null` and `total leaves = 5`. Effective score keeps the existing fallback to `previous_attempts[last]` so a resubmission in flight doesn't drop the grade.

3. **Ranking line: `📊 Reyting: #X / N · Y ball`**
   - `leaderboard_cache.computed_at` is **2 days stale** (last `recalc_leaderboard()` was 2026-05-10). So rank, score, lessons_30d, minutes_30d, and current_streak shown to students are all out-of-date.
   - **Fix (two parts):**
     - On every `/Statistikam` call, if `leaderboard_cache.computed_at` is older than 1 hour, call `admin.rpc("recalc_leaderboard")` once before reading the user's row. Cheap (single RPC) and bounded.
     - Add a daily cron (via existing `pg_cron` + `pg_net`) that hits the existing `leaderboard-recalc` edge function at 00:10 Tashkent time so the cache stays fresh even when no one opens stats. Use `supabase--insert` (not migration) since it carries the project-specific function URL and anon key.

4. **Daily goal / streak / badges lines** — already read live from `streaks`, `lesson_progress`, `user_badges`, `badges`. No bug.

5. **Teacher `/tstats`** — calls `teacher_group_statistics(p_group_id, p_caller_profile_id)` RPC, which is computed live (messages today/7d/30d, active students, pending homework count, avg module score). I'll spot-check the RPC output but plan to leave it alone unless it returns visibly wrong numbers. No change planned to teacher side beyond what was already done in the previous loop (inactive students list).

## Changes

### A. `supabase/functions/telegram-bot-webhook/index.ts`

1. **Translation strings** (`T.uz`, `T.ru`, `T.en`):
   - `statsLessons(d, tot, mins)` → `"📚 Darslar: <b>${d}/${tot}</b> ko'rilgan · ${fmtDuration(mins)} jami"` (and ru/en equivalents).
   - Replace `statsHomework(s, tot, avg)` with `statsHomework(submitted, totalLeaves, earned, maxTotal, avg)` →
     `"📝 Uy vazifalari: <b>${submitted}/${totalLeaves}</b> topshirildi · ${earned}/${maxTotal} ball (o'rtacha ${avg}/10)"`.
   - Keep `statsHomeworkNone` for "nothing graded yet".

2. **`buildStatsMessage`** (around lines 1045–1141):
   - Add `daily_watch_summary` aggregate fetch: `SELECT COALESCE(SUM(total_seconds),0) FROM daily_watch_summary WHERE user_id = :uid`. Pass total minutes into `statsLessons`.
   - In the leaves loop, also count `submittedLeaves` (leaves whose effective score is not null) and pass both `(submittedLeaves, leaves.length, earned, maxTotal, avg)` into `statsHomework`.
   - Right before the parallel fetch, add a freshness check + refresh:
     ```ts
     const { data: lbAge } = await admin
       .from("leaderboard_cache").select("computed_at").limit(1).maybeSingle();
     if (!lbAge || Date.now() - new Date(lbAge.computed_at).getTime() > 60 * 60 * 1000) {
       await admin.rpc("recalc_leaderboard"); // fire-and-await, cheap
     }
     ```

3. Small helper `fmtDuration(seconds)` → `"2h 14m"` / `"45m"` / `"—"`.

### B. Schedule daily leaderboard refresh

Use `supabase--insert` (NOT migration; carries project-specific URL + anon key) to register a `pg_cron` job:

```sql
select cron.schedule(
  'leaderboard-recalc-daily',
  '10 19 * * *', -- 00:10 Tashkent (UTC+5)
  $$
  select net.http_post(
    url := 'https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/leaderboard-recalc',
    headers := '{"Content-Type":"application/json","apikey":"<anon key>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```

(`pg_cron` and `pg_net` are already enabled — other crons in this project use them.)

### C. No DB schema changes

Everything else is read-only against existing tables.

## Out of scope

- Changing how `track_video_progress` decides "completed". The current rule is intentional and shared with the website's progress UI; redefining it would make web and bot disagree.
- Reworking the teacher `/tstats` numbers (they come from a live RPC and match the DB). If the user reports a specific teacher number that's wrong, I'll fix it as a follow-up.
- The website's `MyActivity` page and `HomeworkProfileSection` already show points correctly per module; they don't have the same labeling bug.

## Verification after deploy

- Run `/Statistikam` as a sample student in Telegram. Expect:
  - Lessons line shows `X/36` with a real "Yh Ym jami" suffix.
  - Homework line shows both `submitted/total` and `earned/max points`.
  - Ranking line uses a `computed_at` within the last hour.
- Re-check `select max(computed_at) from leaderboard_cache;` — should be within minutes of the test.
- Confirm one teacher `/tstats` matches a manual count of last-7-day messages in `group_message_events`.
