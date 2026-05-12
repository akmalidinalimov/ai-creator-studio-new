## Goal

Fix the "📝 Uy vazifalari" line in the Telegram `/Statistikam` message so it reflects the **real maximum points** across all active homework leaves and so that **resubmissions don't erase the previously earned grade** until the teacher re-grades.

## Current behavior (bug)

In `supabase/functions/telegram-bot-webhook/index.ts` (`buildStatsMessage`, lines ~1064–1110):

- `subs.length` = number of submission rows the student has → currently shown as the numerator ("4")
- `hwTotalRes.count` = number of `homework_assignments` rows (including parent containers like Module 3, plus its 3 SAPs) → shown as denominator ("6")
- Average is computed from `vw_module_homework_score.avg_score_normalized`, which **only counts rows where `score IS NOT NULL`**. When a student resubmits, `start_homework_resubmission` sets `score = NULL` and pushes the old score into `previous_attempts`, so that homework instantly drops out of the average.

## Target behavior

Line should read:
`📝 Uy vazifalari: <earned>/<max_total> (o'rtacha <avg>/10)`

where, computed over **leaf** assignments only (a leaf = an assignment with no children — same definition `vw_module_homework_score` already uses):

- `max_total` = sum of `max_score` over every active leaf (e.g. M1=10 + M2=10 + M3.S1=10 + M3.S2=10 + M3.S3=10 = 50).
- `earned` = sum of the student's **effective score** per leaf, where effective score is:
  1. `homework_submissions.score` if not null, else
  2. the most recent `previous_attempts[].score` if any, else
  3. nothing (leaf not counted toward earned, but still in `max_total`).
- `avg` = `round(earned / max_total * 10, 1)` (one decimal). If no scores yet → use the existing "hali topshirilmadi" line.

This guarantees: (a) the denominator reflects the true maximum any student could earn, and (b) resubmissions keep the previously awarded grade visible until the teacher posts a new score.

## Changes

### 1. Edge function — `supabase/functions/telegram-bot-webhook/index.ts`

In `buildStatsMessage`:

- Replace the `hwSubRes` / `hwTotalRes` queries with a single fetch of active leaves and the student's submissions:
  - `homework_assignments` where `is_active = true`, selecting `id, max_score, parent_id` (we'll filter to leaves in JS using the same rule as `computeLeaves` / the view).
  - `homework_submissions` for `user_id = userId`, selecting `assignment_id, score, previous_attempts`.
- Compute `max_total = Σ leaf.max_score`.
- Compute `earned = Σ effective_score(leaf)` using the fallback to `previous_attempts` described above (pick the last entry's `score` since `start_homework_resubmission` appends).
- Drop the `vw_module_homework_score` query — no longer needed for this line.
- Update the `statsHomework` template strings in `T.uz` / `T.ru` / `T.en` from
  `"📝 Uy vazifalari: <b>${s}/${tot}</b> (o'rtacha ${avg}/10)"` to a points-based version, e.g.
  `"📝 Uy vazifalari: <b>${earned}/${max}</b> (o'rtacha ${avg}/10)"`.
  Keep `statsHomeworkNone` for the case where no leaf has any effective score.

### 2. No DB migration required

`previous_attempts` already stores prior scores as JSON snapshots, and the view stays untouched (other UI surfaces still use it). All logic lives in the bot edge function.

### 3. Out of scope (confirm before touching)

- The website's `HomeworkProfileSection` ("📝 Uy vazifalari" card on the profile page) uses a different per-module average; not part of this request.
- Teacher dashboard tiles — unchanged.

## Technical notes

- Leaf detection mirrors the existing helper `computeLeaves` in `supabase/functions/telegram-bot-webhook/homework-routing.ts` and the `vw_module_homework_score` CTE: an assignment is a leaf iff no other active assignment has it as `parent_id`.
- `previous_attempts` is appended in chronological order by `start_homework_resubmission` (`COALESCE(previous_attempts, '[]') || v_snapshot`), so the last element is the most recent prior grade — that's what we surface during the in-flight resubmission window.
- After deploy, verify with the screenshot's user: graded M1 V1, M2 V2 (8/10), and one resubmitted task should yield something like `8/50 · 1.6/10` until the teacher re-grades, then jump back up.
