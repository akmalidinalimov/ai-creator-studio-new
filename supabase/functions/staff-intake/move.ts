// What the /intake form answers when the student already sits in ANOTHER group (pure; unit-tested).
// The rule itself lives in _shared/course-move-guard.ts; this maps its verdict onto the form's protocol:
//   - refused              -> { status: "cross_course_refused", message, the old/new course, waiting count,
//                               can_override }, and the caller writes an admin_actions row. confirm_move does
//                               NOT skip it (it used to skip the whole guard).
//   - same course, first   -> { status: "exists_in_other_group" } so the salesperson confirms the move.
//   - same course, confirm -> proceed (the engine moves them, as before).
//   - admin override       -> proceed, with the admin id for the engine to re-verify and audit.
import {
  type CourseMoveFacts,
  type CourseMoveVerdict,
  moveSummary,
  overridePossible,
  refusalMessage,
  REFUSED_STATUS,
  type RefuseReason,
} from "../_shared/course-move-guard.ts";

export type IntakeMoveOutcome =
  | { action: "respond"; body: Record<string, unknown>; refused: RefuseReason | null }
  | { action: "proceed"; overrideAdminId: string | null };

export function intakeMoveOutcome(
  facts: CourseMoveFacts,
  verdict: CourseMoveVerdict,
  opts: { confirmMove: boolean; callerAdminId: string | null; userId: string },
): IntakeMoveOutcome {
  if (verdict.kind === "refused") {
    return {
      action: "respond",
      refused: verdict.reason,
      body: {
        status: REFUSED_STATUS,
        reason: verdict.reason,
        message: refusalMessage(facts, verdict.reason),
        ...moveSummary(facts),
        // The form offers the admin override only when the server says it would pass.
        can_override: !!opts.callerAdminId && overridePossible(facts),
      },
    };
  }
  if (verdict.kind === "same_course" && !opts.confirmMove) {
    return {
      action: "respond",
      refused: null,
      body: {
        status: "exists_in_other_group",
        userId: opts.userId,
        current_group: facts.fromGroupName,
        current_course: facts.fromCourseTitle,
        old_course_waiting: facts.oldCourseWaiting,
      },
    };
  }
  return { action: "proceed", overrideAdminId: verdict.kind === "override" ? verdict.adminId : null };
}
