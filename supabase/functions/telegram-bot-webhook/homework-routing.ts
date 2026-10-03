// Pure helpers for SAP/leaf homework routing. No I/O — easy to unit-test.

export type AssignmentRow = {
  id: string;
  task_number: number | null;
  sap_number: number | null;
  parent_id: string | null;
  is_active?: boolean | null;
};

export type SubmissionRow = {
  assignment_id: string;
  score: number | null;
};

/**
 * A "leaf" is what students submit against:
 *   - a SAP row (parent_id IS NOT NULL), OR
 *   - a parent row that has no SAP children.
 * Parents that have children are containers and are excluded.
 *
 * Output is sorted by (task_number, sap_number) ascending so callers can pick
 * the next un-graded one deterministically.
 *
 * If `is_active` is present on rows, inactive rows are filtered out first.
 */
export function computeLeaves(all: AssignmentRow[]): AssignmentRow[] {
  const active = all.filter((a) => a.is_active !== false);
  const parentIdsWithSap = new Set(
    active.filter((a) => a.parent_id).map((a) => a.parent_id as string),
  );
  const leaves = active.filter(
    (a) => a.parent_id !== null || !parentIdsWithSap.has(a.id),
  );
  leaves.sort(
    (x, y) =>
      (x.task_number ?? 0) - (y.task_number ?? 0) ||
      (x.sap_number ?? 0) - (y.sap_number ?? 0) ||
      // Stable id tiebreak: the picker/retag resolve leaves[index] from a fetch with no ORDER BY,
      // so the order must be identical across two separate fetches even if two leaves happen to
      // share (task_number, sap_number). Without this, DB row order could leak into the index.
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return leaves;
}

/**
 * The step number shown to humans (student receipts, teacher DMs, picker labels).
 * For a SAP sub-step (parent_id set) that is its `sap_number` — so Module 3's sub-steps read
 * "Vazifa 1/2/3" instead of all sharing the parent's `task_number` (=3), the reported bug.
 * For a normal task it is `task_number`, unchanged. Never throws; defaults to 1.
 */
export function displayStepNumber(
  leaf: { parent_id: string | null; task_number: number | null; sap_number: number | null },
): number {
  if (leaf.parent_id != null) return leaf.sap_number ?? leaf.task_number ?? 1;
  return leaf.task_number ?? 1;
}

/**
 * Pick the next leaf to attach an incoming submission to:
 *   1. The first leaf (in order) with no submission OR submission.score == null.
 *   2. If every leaf is already graded, fall back to the last leaf so the
 *      message still attaches to something.
 *   3. If `leaves` is empty, return null.
 */
export function pickNextLeaf(
  leaves: AssignmentRow[],
  subs: SubmissionRow[],
): AssignmentRow | null {
  if (!leaves.length) return null;
  const subMap = new Map(subs.map((s) => [s.assignment_id, s]));
  const next = leaves.find((l) => {
    const s = subMap.get(l.id);
    return !s || s.score == null;
  });
  return next ?? leaves[leaves.length - 1];
}

/**
 * The auto-tag guess for a bare post in a shared homework topic (the picker's expiry sweep and the
 * no-picker auto path), restricted to the modules the student can open.
 *
 * It used to guess across EVERY module. On a tiered course that guess lands on a locked module as
 * soon as the student's open work is graded — on the Challenge 6.0 ladder (module 1 only, one task)
 * that is every student whose module-1 homework has been graded — and finalize then dropped the
 * post as tier_locked with no reaction and no message (7 posts on 2026-10-02/03). Now:
 *   1. an ungraded leaf in the student's current module (last watched / last submitted), else
 *   2. one in the module right after it, else
 *   3. pickNextLeaf over the open leaves (first ungraded; all graded → the last one, which the
 *      caller then treats as "already graded" and asks about a resubmission).
 * Only when the student can open NO module with a task does it fall back to the unfiltered list
 * (the old behaviour), so the caller's tier gate still decides and says so.
 */
export function chooseGuessLeaf<L extends AssignmentRow & { module_id: string }>(o: {
  leaves: L[];                  // computeLeaves() of the whole course
  moduleOrder: string[];        // module ids by position
  blocked: Set<string>;         // modules beyond the student's tier
  subs: SubmissionRow[];
  currentModuleId: string | null;
}): L | null {
  const open = o.leaves.filter((l) => !o.blocked.has(l.module_id));
  const pool = open.length ? open : o.leaves;
  if (!pool.length) return null;
  const subMap = new Map(o.subs.map((s) => [s.assignment_id, s]));
  const ungradedIn = (mid: string | undefined) =>
    mid ? pool.find((l) => l.module_id === mid && (subMap.get(l.id)?.score ?? null) == null) : undefined;
  if (o.currentModuleId) {
    const here = ungradedIn(o.currentModuleId);
    if (here) return here;
    const idx = o.moduleOrder.indexOf(o.currentModuleId);
    const after = idx >= 0 ? ungradedIn(o.moduleOrder[idx + 1]) : undefined;
    if (after) return after;
  }
  return pickNextLeaf(pool, o.subs) as L | null;
}
