// The result row for a group move the cross-course guard refused (pure; unit-tested).
//
// It carries NO `userId`, on purpose. Every caller treats a userId as "the student is placed" and goes on to
// act on the TARGET course: staff-intake and sheet-sync call set_enrollment_tier_system (which would enroll
// the refused student in the new course after all) and staff-intake rewrites account_type/phone. Without a
// userId they report the status and stop; the bot's auto-register records it as engine_refused. The matched
// profile is kept in `matched_user_id` for the admin screens and the audit.
import {
  type CourseMoveFacts,
  DB_REFUSAL_PREFIX,
  dbRefusalFacts,
  moveSummary,
  refusalMessage,
  REFUSED_STATUS,
  type RefuseReason,
} from "../_shared/course-move-guard.ts";

export type RefusedMoveRow = {
  email: string;
  status: typeof REFUSED_STATUS;
  error: string;
  reason: RefuseReason;
  matched_user_id: string;
  /** Never set: see the header. */
  userId?: never;
  move: ReturnType<typeof moveSummary>;
  row_index: number;
  identifier_used: string;
};

export function refusedMoveRow(
  facts: CourseMoveFacts,
  reason: RefuseReason,
  row: { email: string; row_index: number; identifier_used: string },
  matchedUserId: string,
): RefusedMoveRow {
  return {
    email: row.email,
    status: REFUSED_STATUS,
    error: refusalMessage(facts, reason),
    reason,
    matched_user_id: matchedUserId,
    move: moveSummary(facts),
    row_index: row.row_index,
    identifier_used: row.identifier_used,
  };
}

/**
 * The same refusal row for a move the DATABASE guard refused at the write (PR-3b, migration 20260930181000):
 * homework arrived between the engine's check and its profiles UPDATE. null when `err` is any other error, so
 * the caller keeps its generic "error" row. The facts come from the refusal's DETAIL; when they are unreadable
 * the database's own Uzbek sentence is kept instead of a count we do not know.
 */
export function dbRefusedMoveRow(
  err: { message?: string | null; details?: string | null } | null | undefined,
  row: { email: string; row_index: number; identifier_used: string },
  matchedUserId: string,
): RefusedMoveRow | null {
  const facts = dbRefusalFacts(err);
  if (!facts) return null;
  const out = refusedMoveRow(facts, "old_course_waiting", row, matchedUserId);
  if (facts.oldCourseWaiting === null) {
    const own = String(err?.message ?? "").trim().slice(DB_REFUSAL_PREFIX.length).trim();
    if (own) out.error = own;
  }
  return out;
}
