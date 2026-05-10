## Problem

Students watch videos (mostly Bunny) but `lesson_progress.completed_at` rarely gets set. As a result:

- Telegram bot stats show "0/36" or low completion counts even after many lessons watched.
- The "Continue / Watch next" button on the course page picks the first lesson without `completed_at`, so it keeps sending the user back to lesson 1.1.
- Module/forecast progress in the web dashboard is also low.

### What I verified in the database

- Course `AI CREATORS` has 36 published lessons. So stats math is fine **if** completions are recorded.
- `lesson_progress` rows are being written (recent rows show `last_position_seconds`, `max_position_seconds`, `watch_seconds_total` updating every 5 s). Recording is working.
- Many rows where students clearly watched a lot have no `completed_at`. Examples:
  - user `9234b70a` lesson `fc6d4e32`: max ≈ 339 s of dur ≈ 917 s (37%) — student probably stopped.
  - user `940dd4f3` lesson `38d2eb42`: max ≈ 247 s of dur ≈ 277 s (89%) — just below 90% threshold, never completed.
  - user `ec99a717` lesson `c9865017`: max ≈ 1381 s of dur ≈ 1892 s (73%) — duration likely cached too high; user watched the whole video but threshold never hit.
- Aggregate per user shows several students with `completed = 0` but multiple `lesson_progress` rows (3d8093ac, ec99a717, b7e387b7, f38dfd40 …). This is the exact symptom the students reported.

### Root causes

1. **90% completion threshold is too strict** for the Bunny player. Bunny's `player.js` `timeupdate` is throttled and the iframe `ended` event is unreliable in cross-origin embeds, so a student who watches to the end often never gets `cur ≥ 0.9 * duration`.
2. **`duration_seconds_v2` is sticky.** `track_video_progress` stores duration once via `COALESCE(...)` and never overwrites it. If an early tick reported a wrong/longer duration (e.g. because the iframe wasn't fully ready, or a different cut was originally uploaded), the threshold becomes unreachable.
3. **No "ended" → complete fallback for native uploads.** Only the Bunny path calls `onEnded` → upsert `completed_at`. Native HTML5 has no equivalent listener.
4. **Telegram stats and "Watch next" both depend solely on `completed_at`** — when (1)–(3) silently fail, both surfaces look broken.

## Fix plan

### 1. `supabase/functions/...` migration — make `track_video_progress` more forgiving

Update the RPC to:

- Lower the auto-complete threshold from **0.90 → 0.85** of duration.
- Also auto-complete when `max_position_seconds >= duration - 20` (covers cases where Bunny's last reported time stops a few seconds short of the true end, e.g. final tick at 1135 s of 1156 s).
- **Refresh `duration_seconds_v2` when the new reported duration is meaningfully smaller** (`new_dur > 0 AND (stored IS NULL OR new_dur < stored * 0.95)`). This unsticks lessons where the original cached duration was wrong/too high, without letting a single bad tick of `0` clobber it.
- Backfill: one-time `UPDATE lesson_progress SET completed_at = COALESCE(completed_at, updated_at) WHERE completed_at IS NULL AND duration_seconds_v2 > 0 AND (max_position_seconds / duration_seconds_v2) >= 0.85;` so existing students immediately see correct counts and the "Watch next" button moves forward.

### 2. `src/components/BunnyVideoPlayer.tsx` — more reliable end detection

- Keep the existing `ended` listener but also, on every internal 5 s tick, if `durationRef > 0 && lastTimeRef >= durationRef - 5 && !endedFiredRef`, fire `onEnded`. This catches the common case where Bunny's `ended` event never arrives.
- When the player.js `ended` event fires, send one final `onTimeUpdate(duration, duration)` (already done) and one extra `onTimeUpdate(duration, duration)` after a 1 s delay as a safety retry, so the RPC has a fresh tick with a valid duration.

### 3. `src/pages/LessonPage.tsx` — symmetric fallback for native `<video>`

- Add an `onEnded` handler on the native HTML5 video that does the same `lesson_progress` upsert with `completed_at = now()` that the Bunny path already does.
- After the existing 5 s native interval tick, if `cur >= dur - 5 && dur > 0`, also upsert `completed_at`. This mirrors the Bunny behavior server-side and is cheap.
- `goNext()` already calls `markComplete()` before navigating — leave as is; this means clicking the in-page "Next" button always advances even if auto-complete missed.

### 4. Telegram bot — show counts even when nothing is recorded yet

`supabase/functions/telegram-bot-webhook/index.ts` already builds `t.statsLessons(completedLessons, totalLessons)`. With fix #1 the numbers will be correct. No code change needed there beyond a sanity check that the default course resolves (it does — `AI CREATORS` is `is_default_for_signup = true`).

### 5. End-to-end verification

After deploying:

1. Re-run the backfill SQL and confirm rows like `940dd4f3 / 38d2eb42` (89%) and `ec99a717 / c9865017` (73% but probably fully watched) get `completed_at` set.
2. Open lesson 1.1 in the preview, let Bunny play to ~end, refresh course page — "Continue" must point to 1.2.
3. In Telegram, tap "📊 My stats" — confirm `Lessons: N/36` increments after a lesson finishes.
4. Spot-check one teacher account in the admin dashboard to confirm no regression in their progress views.

### Files

- `supabase/migrations/<new>.sql` — updated `track_video_progress` + one-time backfill UPDATE.
- `src/components/BunnyVideoPlayer.tsx` — near-end auto-fire `onEnded`, retry tick.
- `src/pages/LessonPage.tsx` — native `<video>` ended/near-end completion upsert.
- No changes to the Telegram webhook code.
