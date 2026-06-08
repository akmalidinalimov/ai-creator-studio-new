# Student-Performance Statistics — Dependency Map & Propagation Contract

> Authoritative reference for how grading / lessons / streaks / homework flow through the
> system. Produced from a 4-pass audit (DB layer, web read-sites, bot + edge functions,
> point-bug confirmation). This is the **contract** that Workstream D (D2–D5) implements and
> that the parity harness (D5) checks against. When you change any stat computation, update
> this file in the same PR.

## TL;DR — the three problems

1. **No write auto-propagates to the leaderboard.** Every event that should move a rank or a
   denominator (grade saved, lesson completed, homework submitted, student created, duplicates
   merged, student archived, group changed, assignment deactivated, weights changed) leaves
   `leaderboard_cache` stale until the nightly/manual recalc.
2. **`recalc_leaderboard` is itself wrong.** Homework uses raw `AVG(score)` (not normalized by
   `max_score`); the no-homework branch scaling can exceed 100; it does **not** exclude
   archived/inactive students, so archived users pollute everyone's rank.
3. **Homework average diverges across surfaces.** Only `HomeworkProfileSection` (web) and the
   bot use the correct effective-grade rule (`previous_attempts` fallback). `MyActivity`,
   `HomeworkSection`, and the SQL view `vw_module_homework_score` use raw current score.

The fix is a single source of truth for the homework grade rule, a correct + UPSERT-based
`recalc_leaderboard`, and a `stats_dirty_at` dirty-flag + frequent cron so every write
propagates automatically to web **and** Telegram bot.

---

## 1. Canonical metric definitions (the single source of truth)

| Metric | Canonical rule | Reference implementation |
|---|---|---|
| **Leaf assignment** | active assignments where `parent_id IS NOT NULL` OR the assignment has no active SAP children | `leavesFromAssignments()` in `src/lib/homeworkStats.ts`; mirror in SQL |
| **Effective score** (per leaf) | current `score` if not null; else the **last scored** entry in `previous_attempts`; else null | `effectiveLeafGrades()` in `src/lib/homeworkStats.ts` |
| **Homework avg (avg10)** | `SUM(effective_score) / SUM(max_score over scored leaves) * 10` | `summarizeHomework()` → `avg10` |
| **Homework submitted** | count of leaves with any submission row | `summarizeHomework().submittedCount` |
| **Homework scored** | count of leaves with non-null effective score | `summarizeHomework().scoredCount` |
| **Lessons completed** | `lesson_progress` rows with `completed_at IS NOT NULL` | trigger-maintained |
| **Watch time** | `SUM(daily_watch_summary.total_seconds)` (or `lesson_progress.watch_seconds_total`) | `track_video_progress()` |
| **Streak** | `streaks.current_streak` / `longest_streak` | `update_streak_for_user()` trigger + `zero_broken_streaks()` |
| **Leaderboard score** | weighted: `0.4·lessons + 0.3·(avg10/10) + 0.2·(streak/30) + 0.1·minutes`, ×100, clamp 0–100, **active non-archived only** | `recalc_leaderboard()` (to be fixed in D3) |
| **Leaderboard rank / denominator** | `ROW_NUMBER() OVER (ORDER BY score DESC, …)` over all active members | `recalc_leaderboard()` |
| **Badges** | trigger-awarded on lesson/streak/homework milestones | `award_badge()` + evaluate triggers |

**Rule:** the homework-grade computation (leaf + effective score + avg10) must be identical in
(a) `src/lib/homeworkStats.ts`, (b) `supabase/functions/telegram-bot-webhook/homework-stats.ts`
(currently identical — keep so), and (c) one SQL effective view (D2 creates it). No surface may
compute homework averages from raw `score` directly.

---

## 2. Write event → downstream consumers (propagation graph)

Legend: ✅ auto today · ⚠️ partial · ❌ NOT auto (the gaps D4 closes).

### Grade saved (`homework_submissions.score` set, web or bot)
- `homework_submissions` row → ✅ `trg_validate_hw_submission` (range check)
- Bot `/galaba` reply cache → ✅ invalidated (bot path) · web has no cache
- `leaderboard_cache` (score + everyone's rank) → ❌ **no recalc**
- `vw_module_homework_score` → ⚠️ reflects at query time but ignores `previous_attempts`
- `teacher_group_statistics` (avg_module_score, pending count) → ⚠️ query-time only
- **D4 fix:** grade write marks `profiles.stats_dirty_at` → frequent cron recomputes that user's `leaderboard_cache` row.

### Lesson completed (`lesson_progress.completed_at` set)
- Badges (`first_lesson`, `five_lessons`, …, `module_complete`, `course_complete`) → ✅ `trg_evaluate_lesson_badges`
- Streak (`streaks.current_streak/longest`) → ✅ `trg_lesson_progress_streak` → ✅ streak badges
- Module-celebration nudge → ✅ `trg_enqueue_module_complete_nudge`
- `daily_watch_summary` → ✅ via `track_video_progress()`
- `leaderboard_cache` (lessons_30d weight 0.4) → ❌ **no recalc**
- Analytics MVs → ⚠️ nightly only
- **D4 fix:** completion marks `stats_dirty_at`.

### Homework submitted (first submission, `score = null`)
- `first_homework` badge → ✅ `trg_award_first_homework`
- `leaderboard_cache` → ❌ (homework component stays null until graded; fine) — but pending counts query-time only
- **D4 fix:** mark dirty (cheap; recompute is a no-op for score until graded).

### Student created / enrolled (`profiles` + `enrollments` insert)
- `profiles`, `user_roles`, `streaks(0)`, `enrollments` → ✅ via `on_auth_user_created`
- `leaderboard_cache` membership + **everyone's rank denominator** → ❌ new student absent until recalc
- **D4 fix:** `admin-create-students` marks new users dirty (and a full-recalc tick fixes denominators).

### Duplicates merged (`admin-merge-duplicates`)
- Duplicate `profiles`/`auth.users` deleted → denominator shrinks → ❌ leaderboard stale
- **D4 fix:** mark remaining/all dirty after merge.

### Student archived (`profiles.archived_at` set)
- Group stat functions exclude archived → ✅
- `leaderboard_cache` → ❌ **archived user stays in the leaderboard** (recalc doesn't even filter archived — D3 fixes the filter; D4 marks dirty on archive).

### Group changed (`profiles.group_id`) / Assignment deactivated (`homework_assignments.is_active`) / Weights changed (`app_settings`)
- All → ❌ leaderboard / group caches stale until manual recalc.
- **D4 fix:** triggers on group_id + is_active mark dirty; weight change → schedule a full recalc tick.

### Streak broken (inactivity)
- Only corrected on the user's **next** activity (`trg_lesson_progress_streak`), or by `zero_broken_streaks()` — which **has no cron**.
- **D4 fix:** schedule `zero_broken_streaks` daily; mark affected users dirty.

---

## 3. Read surfaces → source & formula (consistency matrix)

| Surface | File | Homework avg | previous_attempts | Rank/score | Notes |
|---|---|---|---|---|---|
| Profile homework | `src/components/HomeworkProfileSection.tsx` | ✅ effectiveLeafGrades | ✅ | — | **correct reference** |
| Lesson homework | `src/components/lesson/HomeworkSection.tsx` | ❌ raw, scored-only denom | ❌ | — | **C3 fixes** |
| My Activity | `src/pages/MyActivity.tsx` | ❌ raw avg (~168) | ❌ | — | **D2 fixes** |
| Admin homework | `src/pages/admin/AdminHomework.tsx` | ❌ via `vw_module_homework_score` | ❌ | — | **D2 repoints to effective view** |
| Student detail | `src/pages/admin/AdminStudentDetail.tsx` | raw (status only) | partial | cache | counts only; acceptable |
| Leaderboard | `src/pages/Leaderboard.tsx` | — | — | ✅ cache via `leaderboard_top`/`leaderboard_my_rank` | depends on D3 correctness |
| Dashboard / EngagementTiles / StudentAnalytics | `src/pages/Dashboard.tsx`, `src/components/dashboard/*` | — | — | streak/lessons/goal via RPC | consistent |
| Bot `/galaba` | `telegram-bot-webhook/index.ts` `buildStatsMessage` | ✅ summarizeHomework | ✅ | ✅ cache | 30s reply cache; 1h lazy recalc |
| Bot `/vazifalar` | `telegram-bot-webhook/index.ts` `buildHomeworkMessage` | per-task raw `score` | ❌ | — | shows per-task; D2 align to effective |

`vw_module_homework_score` (migration `20260503182607`) and `recalc_leaderboard` (migration
`20260505143045`) are the two SQL objects that must change. Bot `homework-stats.ts` ≡ web
`homeworkStats.ts` today — a drift test (D2) keeps them locked.

---

## 4. DB objects in the stats domain (quick index)

- **Functions:** `recalc_leaderboard` (D3), `track_video_progress`, `award_badge`,
  `evaluate_lesson_badges`, `evaluate_streak_badges`, `zero_broken_streaks` (needs cron),
  `teacher_group_statistics`, `admin_group_module_submissions`, `admin_group_engagement_stats`,
  `staff_group_overview`, `group_health_score`, `leaderboard_top`, `leaderboard_my_rank`,
  `daily_goal_progress`, `homework_pending_count_for_user`, analytics fns.
- **Triggers:** `trg_validate_hw_submission`, `trg_award_first_homework` (on `homework_submissions`);
  `trg_evaluate_lesson_badges`, `trg_lesson_progress_streak`, `trg_enqueue_module_complete_nudge`
  (on `lesson_progress`); `trg_evaluate_streak_badges` (on `streaks`).
- **Views:** `vw_module_homework_score` (real-time). **MVs:** `mv_funnel_stages`,
  `mv_cohort_retention`, `mv_lesson_dropoff`, `mv_study_heatmap_30d` (nightly `refresh_all_analytics`, cron `0 22 * * *`).
- **Cron present:** `refresh_all_analytics` only. **Cron MISSING:** `leaderboard-recalc` (incremental + nightly), `zero_broken_streaks`.
- **Dead column:** `profiles.stats_dirty_at` (no writer/reader) → becomes the propagation backbone (D4).

---

## 5. What D2–D5 must guarantee (acceptance contract)

- **D2:** all homework-avg surfaces (Profile, Lesson, MyActivity, Admin, bot) return the *same*
  number for the same student; one SQL effective view; drift test pins bot ≡ web.
- **D3:** `recalc_leaderboard` = normalized effective homework, excludes archived/inactive, no
  >100 scaling, UPSERT, every active student has a row; leaderboard avg matches web `avg10`.
- **D4:** every write event in §2 marked ❌/⚠️ gets an automatic path: `stats_dirty_at` trigger
  → frequent incremental cron (2–5 min) + nightly full recalc + daily `zero_broken_streaks`;
  edge-fn hooks for create/merge. A grade reflects on site + bot within one cron tick.
- **D5:** one-time backfill makes every current number correct; the parity harness asserts
  web ↔ bot ↔ `leaderboard_cache` ↔ effective view ↔ admin agree for sampled students, run
  before and after backfill, then kept as a regression check.
