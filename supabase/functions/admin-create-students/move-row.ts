// The result row for a group move the cross-course guard refused (pure; unit-tested).
//
// It carries NO `userId`, on purpose. Every caller treats a userId as "the student is placed" and goes on to
// act on the TARGET course: staff-intake and sheet-sync call set_enrollment_tier_system (which would enroll
// the refused student in the new course after all) and staff-intake rewrites account_type/phone. Without a
// userId they report the status and stop; the bot's auto-register records it as engine_refused. The matched
// profile is kept in `matched_user_id` for the admin screens and the audit.
import {
  type CourseMoveFacts,
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
