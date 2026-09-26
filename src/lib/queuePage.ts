/**
 * How many rows a capped (`.limit(pageSize)`) list query left out, given a separate exact count of
 * the same filter — so a UI can say "showing N of M" instead of silently presenting page one as the
 * whole list (TeacherProfile's grading queue, capped at 100 oldest-first).
 *
 * Deliberately conservative — it only ever reports rows the cap itself cut off:
 *  - page not full (`fetched < pageSize`) → 0. The cap cut nothing; a larger count can only come from
 *    a row that arrived between the two parallel requests, and must not raise a false "more" banner.
 *  - count unknown (the count request failed / returned null) → 0, i.e. the view degrades to exactly
 *    what it showed before the indicator existed (the caller beacons the failure).
 *  - count lower than the page (rows graded between the two requests) → 0, never negative.
 */
export function rowsBeyondPage(total: number | null | undefined, fetched: number, pageSize: number): number {
  if (fetched < pageSize) return 0;
  if (typeof total !== "number" || !Number.isFinite(total)) return 0;
  return Math.max(total - fetched, 0);
}
