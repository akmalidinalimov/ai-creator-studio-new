# Streak restore — reconcile damage repair (2026-06-19)

> **Operational record of a one-time production data fix applied directly via the Lovable SQL editor.**
> **⛔ DO NOT RE-RUN the SQL below.** It was already applied to the live database on 2026-06-19 and is
> NOT idempotent — the `WHERE` clause uses a relative date (`last_active_date >= today - 2`), so running
> it again on a different day, or on a rebuilt database, would target the wrong set of students.

## Symptom
A top student (@Asalkhan_8, "Asal") reported her streak dropped from **38 (June 12)** to ~7 overnight on
**June 13**. Investigation showed this hit the platform's most engaged students broadly.

## Root cause
The one-time migration [`supabase/migrations/20260613110500_reconcile_phantom_streaks.sql`](../supabase/migrations/20260613110500_reconcile_phantom_streaks.sql)
recomputed every student's `current_streak` as the consecutive run of "genuine activity" days
(`had_genuine_activity_on_date`) over a 45-day window. It correctly removed *phantom* streaks (credit for
0-second lesson opens), but it **over-truncated genuinely loyal students** because the per-day activity
signal is incomplete for the past:

- A day only counts as a genuine watch if `daily_watch_summary.total_seconds >= 30` — so real but **short
  watch days** (Asal had 25s / 15s / 10s / 5s days) don't count.
- At reconcile time `daily_watch_summary.watch_date` was still stored in **UTC**, but the genuine-activity
  check compared **Asia/Tashkent** dates (the Tashkent fix `20260613114000` landed *after* the reconcile)
  → late-night watches were mis-dated, creating spurious gaps.
- The old streak counted *any* lesson-open; the new strict rule broke the run on every day lacking a
  recorded ≥30s watch / completion / group post / homework.

`longest_streak` was preserved (the reconcile used `GREATEST`), so each victim's pre-reconcile **peak
still sits in `streaks.longest_streak`** — which is what made a clean restore possible.

Confirmed live: @Asalkhan_8 = 59/59 lessons completed, `longest_streak`=38, still active — unambiguously
genuine. Population impact: 105 students ≥5 below peak; **46 currently-active** students ≥7 below peak
(14 of them ≥15 below); worst-hit were full-course-completers (Элшод 42→9, Davron 37→6, Nilufar 41→11).

## Decision (owner-approved 2026-06-19)
- **Restore method:** set `current_streak = longest_streak` for **currently-active** demoted students
  (bounded to `last_active_date >= today - 2` so dead streaks aren't revived).
- **Scope:** all active students below their peak (initially gap ≥ 7, then extended to gap 1–6 = "A1+A2").
  **118 active students restored total.**
- **Inactive** demoted students (39, gap ≥ 5) intentionally left alone — restoring a streak someone has
  already broken is cosmetic and resets to 1 on their next activity.
- **Going-forward gate UNCHANGED** (kept the 30s genuine-activity rule) — no new phantom streaks. The
  destructive reconcile was **not** re-run.

## SQL applied (for the record — DO NOT RE-RUN)
```sql
-- 1) Active students demoted 7+ below peak (46 rows, 629 streak-days restored)
UPDATE public.streaks s
SET current_streak = s.longest_streak
WHERE s.last_active_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 2
  AND s.longest_streak >= s.current_streak + 7
  AND NOT has_role(s.user_id,'admin'::app_role)
  AND NOT has_role(s.user_id,'teacher'::app_role);

-- 2) Extension A1+A2: active students demoted 1-6 below peak (72 rows, 231 streak-days restored)
UPDATE public.streaks s
SET current_streak = s.longest_streak
WHERE s.last_active_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 2
  AND s.longest_streak >= s.current_streak + 1
  AND s.longest_streak <= s.current_streak + 6
  AND NOT has_role(s.user_id,'admin'::app_role)
  AND NOT has_role(s.user_id,'teacher'::app_role);

-- 3) Refresh the leaderboard cache so all surfaces reflect restored streaks immediately
SELECT public.recalc_leaderboard();
```

## Verification (live, after apply)
- @Asalkhan_8: **11 → 38** ✓; Davron → 37 ✓; Элшод → 42 ✓.
- Active students still below their peak: **0** ✓ (all 118 restored).
- Integrity check `current_streak > longest_streak`: **0 violations** ✓.
- Leaderboard cache (487 rows) reflects restored streaks (Asal streak 38). The Telegram bot reads
  `streaks.current_streak` live, so students see the corrected value on their next `/galaba`.

## Notes
- Applied directly to the live Supabase DB (project `wpdztrijasgmxgliwddr`) — the only production database.
  A `git push` does not apply DB changes for this project; DB changes are made only via the Lovable SQL
  editor. This file is documentation only.
- If this damage class recurs, prefer fixing the going-forward gate (lower the 30s threshold / ensure
  Tashkent date consistency) over re-running any blanket reconcile.

---

## UPDATE 2026-06-19 (later) — restore SUPERSEDED by an honest recompute + audit fixes

The restore above set `current_streak = longest_streak`, which (a) **masked real streak breaks**
(@Asalkhan_8 had a genuine 4-day gap June 13–16; her honest run is 3, not 38) and (b) left
`last_active_date` stale, so the nightly breaker would re-erode ~71 of the 118 restored streaks. A
multi-agent audit of the streak/stats subsystem confirmed this and surfaced more issues. Owner chose an
**honest current-run recompute** + shipping the code fixes.

### Honest recompute (applied via SQL editor — DO NOT RE-RUN, relative dates)
Recomputes `current_streak` over the RELIABLE window `[2026-06-13 .. today]` (before that,
`daily_watch_summary.watch_date` is UTC-misfiled — see audit finding #2). Genuine day = watch ≥30s OR
completion OR group-topic post OR homework (all Asia/Tashkent). Rule: gap in-window → honest run since
last gap; continuous since 6/13 → keep `longest_streak` (don't truncate dedicated students past the
unreliable boundary); no genuine activity in last 2 days → 0. Also anchors `last_active_date` to the last
genuine day and resets `freezes_remaining = 2`.
Result: 497 rows; Asal 39→3 (best 39 kept); 148 corrected down (106 → 0 = genuinely broken); 0 inflated;
349 unchanged; 31 continuous kept peak (top live 50/50/49/49/48); invariant_violations = 0; 83 live / 414
zero (all with `longest_streak` preserved as their record).

### Audit code fixes (shipped via git push + Lovable redeploy/publish)
- **#3** `telegram-bot-webhook/index.ts` daily-goal "today" window: UTC midnight → Asia/Tashkent.
- **#12** bot stats: when `current_streak = 0` but `longest > 0`, show "Streak broken — your record: N,
  start again" (`statsStreakBroken`, uz/ru/en) instead of an awkward "0-day streak".
- **#4** web watch-time heatmaps now compute date windows/keys in Asia/Tashkent to match the writer:
  `StudentAnalytics.tsx`, `MyActivity.tsx`, `AdminStudentDetail.tsx`.
- **#5** `update_streak_for_user` trigger now bumps only when today's Tashkent rollup reaches 30s (or a
  completion), matching `had_genuine_activity_on_date` — migration `20260619120000_streak_trigger_30s_align.sql`.
- Deferred (lower severity): #2 historical `daily_watch_summary` backfill, #6 multi-course completion %
  resolver, #7 breaker `last_active_date` overwrite, #2/#10/#11 latent footguns.
