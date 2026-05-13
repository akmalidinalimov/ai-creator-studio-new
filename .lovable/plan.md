## Goal

Make the "📊 Statistika" view (Telegram bot + web profile) reflect the **true historical** state of each student's lessons and homework. Specifically: never lose a grade or comment when a student resubmits, count only assignments that belong to the student's enrolled course, and show numbers that match what teachers actually awarded.

---

## Problems found (audited against @alikhanova_team)

1. **Course scope is global, not per-student.** `buildStatsMessage` and `buildHomeworkMessage` use `getDefaultCourseId()` (the platform-wide default course). Anyone in another group/course sees the wrong totals.
2. **Resubmission wipes grades from view.** When a student resubmits, `homework_submissions.score` is reset to `NULL` and the old grade is pushed into `previous_attempts`. The bot stats code falls back to that array, but the **web profile (`HomeworkProfileSection`)**, **teacher module/list views**, and any other reader only look at the live `score` column — so historical 8/10 and 10/10 grades silently disappear from the displayed average.
3. **Comments are sometimes lost on regrade.** Old `score_feedback` is preserved into `previous_attempts.score_feedback`, but the new submission row defaults to `score_feedback=NULL`, so the student sees a blank "comment" until the teacher re-comments. We will surface the most recent non-null comment (current → previous_attempts) wherever feedback is shown.
4. **Homework "earned/max" wording confused the user.** The line `📝 Uy vazifalari: 2/5 topshirildi · 18/50 ball` reads as "18 out of 50 homeworks". Reword so each number is unambiguous and add the explicit average back as a single, clearly labelled line.
5. **No backfill/audit job.** Nothing reconciles `homework_submissions` history; we'll add a one-off SQL recompute that does not mutate scores, only restores any `score`/`score_feedback` that was clobbered to NULL while a graded value still exists in `previous_attempts` for the **same `attempt_number`** (i.e. the resubmission was never actually re-graded — the old grade should stay visible).

> Out of scope (you confirmed): the lesson `completed_at` rule. We keep ≥85%-watched as-is. We will, however, expose a small admin diagnostic so you can see *which* lessons drove the count.

---

## 1. Shared helper (single source of truth)

Create `supabase/functions/telegram-bot-webhook/homework-stats.ts` (and re-export from a tiny `src/lib/homeworkStats.ts` for the web) with:

```ts
export type LeafEffective = {
  assignment_id: string;
  max_score: number;
  effective_score: number | null;   // current score ?? latest previous_attempts.score
  effective_feedback: string | null; // current feedback ?? latest previous_attempts.score_feedback
  scored_at: string | null;
  submitted: boolean;               // any submission exists (current or previous)
};

export function effectiveLeafGrades(
  leaves: { id: string; max_score: number }[],
  subs:  { assignment_id: string; score: number|null; score_feedback: string|null;
           scored_at: string|null; previous_attempts: any[] }[],
): LeafEffective[];

export function summarizeHomework(rows: LeafEffective[]) {
  const totalLeaves = rows.length;
  const submittedCount = rows.filter(r => r.submitted).length;
  const scoredCount    = rows.filter(r => r.effective_score != null).length;
  const earned         = rows.reduce((s,r) => s + (r.effective_score ?? 0), 0);
  const maxTotal       = rows.reduce((s,r) => s + r.max_score, 0);
  const avg10          = scoredCount ? +(earned / (scoredCount * 10) * 10).toFixed(1) : null;
  return { totalLeaves, submittedCount, scoredCount, earned, maxTotal, avg10 };
}
```

This replaces ad-hoc loops in `buildStatsMessage` (line 1157), `HomeworkProfileSection`, `TeacherHomework` module view, and `weekly-digest`.

## 2. Per-student course scope

Add `getCourseIdsForUser(admin, userId)`:
1. Read `profiles.group_id` → `groups.course_id`. If found, return `[course_id]`.
2. Else read `enrollments` for the user. Return all rows.
3. Else fall back to `getDefaultCourseId()`.

Use it in:
- `buildStatsMessage` (lessons total + homework leaves filter).
- `buildHomeworkMessage`.
- `weekly-digest` per-user totals.
- `HomeworkProfileSection` (filter `homework_assignments` by `module.course_id IN (...)`).

Lesson-id list and assignment query are filtered by these course_ids so totals match what the student actually has.

## 3. Bot stats wording (clearer + explicit average)

Replace single homework line with two lines (UZ shown; same shape for RU/EN):

```
📝 Uy vazifalari: 2/5 ta topshirildi (3 ta baholandi)
🎯 Ball: 26 / 50 · O'rtacha 8.7/10
```

If nothing scored yet → keep `statsHomeworkNone`. Update the three `T[locale].statsHomework` builders accordingly and the call site at line ~1186 to take the new `summarizeHomework` result.

## 4. Persistence rules for grades and comments

Tighten the resubmission path (currently in the bot and `notify-homework-submission`) so that when a new attempt is recorded:

- Push the old `{score, score_feedback, scored_at, scored_by, attempt_number, submitted_at, telegram_message_url, is_late}` into `previous_attempts` (already done).
- **Do not reset `score`/`score_feedback` to NULL until a teacher actually opens the new attempt.** Leave the previous grade in place, marked stale via a new flag `score_is_stale boolean default false` set to `true` on resubmission. Teachers' grading UI already overwrites both columns, so on regrade `score_is_stale` flips back to `false`. (Migration adds the column with a default; no destructive changes.)

This way:
- The student keeps seeing their last real grade and comment.
- The teacher's grading queue still shows "needs review" via `score_is_stale = true` (we'll add a small badge).
- The historical `previous_attempts` array stays intact for audit.

## 5. Historical backfill (one-off, safe)

Insert-only data migration (run via the data-update tool, not a schema migration):

```sql
UPDATE homework_submissions s
SET score          = (s.previous_attempts->-1->>'score')::smallint,
    score_feedback = COALESCE(s.score_feedback, s.previous_attempts->-1->>'score_feedback'),
    scored_at      = COALESCE(s.scored_at,      (s.previous_attempts->-1->>'scored_at')::timestamptz)
WHERE s.score IS NULL
  AND jsonb_array_length(COALESCE(s.previous_attempts, '[]'::jsonb)) > 0
  AND (s.previous_attempts->-1->>'score') IS NOT NULL;
```

This restores ~all displayed grades that resubmissions had blanked out. No grades are invented — we only resurrect a grade that already exists inside `previous_attempts`. Run before deploying the wording change so students see the corrected numbers immediately.

After backfill, also recompute:

- `leaderboard_cache` via existing `recalc_leaderboard()` RPC.
- (If a homework total exists on the leaderboard score formula, it now sees the restored grades.)

## 6. Web profile + teacher views consume the shared helper

- `src/components/HomeworkProfileSection.tsx`: replace its inline aggregation with `summarizeHomework(effectiveLeafGrades(...))`. Show the same two-line summary at the top: `Topshirildi X/Y · Baholandi Z` and `Ball N/M · O'rtacha A/10`. Remove the existing per-module `avg_norm` parenthesis (you already asked us to drop the parenthesis form).
- `src/pages/TeacherHomework.tsx` Module view: when listing per-leaf scores for each submitted student, display the **effective** score+comment (current ?? latest previous attempt) and tag stale rows with a "qayta yuborilgan" pill driven by `score_is_stale`.

## 7. Verification

- `psql` audit script (`scripts/audit_stats.mjs` — Node, read-only) that for a given `--username` prints: course scope used, lesson total + completed list, homework leaves with effective score/max/comment, computed `summarizeHomework` numbers — so you can compare against what the bot/web show. Run on @alikhanova_team to confirm before/after.
- Add one Deno test in `supabase/functions/telegram-bot-webhook/homework-stats.test.ts` covering: current score wins, falls back to latest previous_attempts, ignores empty array, sums max correctly with mixed graded/ungraded leaves.

---

## Files touched

- `supabase/functions/telegram-bot-webhook/homework-stats.ts` (new) + `homework-stats.test.ts` (new)
- `supabase/functions/telegram-bot-webhook/index.ts` — i18n `statsHomework` rewrite, replace `buildStatsMessage` aggregation, add `getCourseIdsForUser`, swap in shared helper in `buildHomeworkMessage` too
- `supabase/functions/notify-homework-submission/index.ts` — keep prior `score`/`score_feedback`, set `score_is_stale=true`
- `supabase/functions/weekly-digest/index.ts` — use shared helper + per-user course scope
- `src/lib/homeworkStats.ts` (new, mirrors helper)
- `src/components/HomeworkProfileSection.tsx` — adopt helper, drop parenthesis avg, show two-line summary
- `src/pages/TeacherHomework.tsx` — show effective score/comment + stale badge
- DB schema migration: `ALTER TABLE homework_submissions ADD COLUMN score_is_stale boolean NOT NULL DEFAULT false;` (RLS unchanged, columns are additive)
- Data migration (insert tool): the historical backfill `UPDATE` above + `SELECT recalc_leaderboard();`
- `scripts/audit_stats.mjs` (new, dev-only)

## Out of scope

- Lesson `completed_at` rule (you said keep it).
- Removing the client-side near-end auto-complete in `LessonPage.tsx` (separate decision).
- Any change to teacher grading UX beyond surfacing the "stale" badge.
