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
      (x.sap_number ?? 0) - (y.sap_number ?? 0),
  );
  return leaves;
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
