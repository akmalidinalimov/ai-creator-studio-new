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
