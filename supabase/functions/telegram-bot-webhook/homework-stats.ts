// Pure helpers for "effective" homework grades.
//
// A submission row's *effective* grade is its current `score` when present,
// otherwise the most recent score in `previous_attempts` (legacy resubmission
// path that blanked the live column). Same rule for `score_feedback` and
// `scored_at` so the student keeps seeing what the teacher actually awarded.

export type LeafLite = { id: string; max_score: number };

export type SubmissionLite = {
  assignment_id: string;
  score: number | null;
  score_feedback: string | null;
  scored_at: string | null;
  previous_attempts?: any[] | null;
};

export type LeafEffective = {
  assignment_id: string;
  max_score: number;
  effective_score: number | null;
  effective_feedback: string | null;
  scored_at: string | null;
  submitted: boolean;
};

function lastScoredAttempt(attempts: any[] | null | undefined): any | null {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a && a.score != null && Number.isFinite(Number(a.score))) return a;
  }
  return null;
}

export function effectiveLeafGrades(
  leaves: LeafLite[],
  subs: SubmissionLite[],
): LeafEffective[] {
  const subMap = new Map(subs.map((s) => [s.assignment_id, s]));
  return leaves.map((leaf) => {
    const s = subMap.get(leaf.id);
    if (!s) {
      return {
        assignment_id: leaf.id,
        max_score: Number(leaf.max_score) || 0,
        effective_score: null,
        effective_feedback: null,
        scored_at: null,
        submitted: false,
      };
    }
    let score: number | null = s.score != null && Number.isFinite(Number(s.score)) ? Number(s.score) : null;
    let feedback: string | null = s.score_feedback ?? null;
    let scoredAt: string | null = s.scored_at ?? null;
    if (score == null) {
      const last = lastScoredAttempt(s.previous_attempts);
      if (last) {
        score = Number(last.score);
        feedback = feedback ?? (last.score_feedback ?? null);
        scoredAt = scoredAt ?? (last.scored_at ?? null);
      }
    }
    return {
      assignment_id: leaf.id,
      max_score: Number(leaf.max_score) || 0,
      effective_score: score,
      effective_feedback: feedback,
      scored_at: scoredAt,
      submitted: true,
    };
  });
}

export type HomeworkSummary = {
  totalLeaves: number;
  submittedCount: number;
  scoredCount: number;
  earned: number;
  maxTotal: number;
  maxScored: number;       // sum of max_score over scored leaves only
  avg10: number | null;    // average grade normalized to /10
};

export function summarizeHomework(rows: LeafEffective[]): HomeworkSummary {
  const totalLeaves = rows.length;
  let submittedCount = 0;
  let scoredCount = 0;
  let earned = 0;
  let maxTotal = 0;
  let maxScored = 0;
  for (const r of rows) {
    maxTotal += r.max_score;
    if (r.submitted) submittedCount++;
    if (r.effective_score != null) {
      scoredCount++;
      earned += r.effective_score;
      maxScored += r.max_score;
    }
  }
  const avg10 = maxScored > 0 ? +((earned / maxScored) * 10).toFixed(1) : null;
  return { totalLeaves, submittedCount, scoredCount, earned, maxTotal, maxScored, avg10 };
}

// Mirror of computeLeaves from homework-routing.ts but accepting a minimal row shape.
export function leavesFromAssignments<T extends { id: string; parent_id: string | null; is_active?: boolean | null }>(
  all: T[],
): T[] {
  const active = all.filter((a) => a.is_active !== false);
  const parentIdsWithSap = new Set(
    active.filter((a) => a.parent_id).map((a) => a.parent_id as string),
  );
  return active.filter((a) => a.parent_id !== null || !parentIdsWithSap.has(a.id));
}
