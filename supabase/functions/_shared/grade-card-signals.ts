// "GRACEFUL IS NOT SILENT" for grade-card delivery (CLAUDE.md, incident doctrine step 5).
//
// Three paths send a student their grade card: bot grading (telegram-bot-webhook), app/web grading
// (notify-grade-voice) and the grade-card-reconcile backstop (every 30 min, 14-day lookback). Each one
// skips a student with no telegram_id, and until now none of them left a row for it: grade_card_dm_sent /
// grade_card_dm_failed record only an ATTEMPTED send, so a card that no path could ever attempt was
// invisible to grade_delivery_watchdog. That skip is expected reach (123 of 690 student profiles had no
// telegram_id on 2026-09-29), so it is a countable signal, never an alarm.
import { logHealthOnce } from "./edge.ts";

/** How far back a grade_card_dm_skipped row suppresses another for the same attempt (= reconciler lookback). */
export const GRADE_CARD_SKIP_WINDOW_DAYS = 14;

/**
 * Is a grade card owed for this submission right now? The same rule every sender applies before it
 * claims grade_card_notified_attempt: a real score, not stale (the graded branch of
 * start_homework_resubmission() keeps the old score and only flags score_is_stale), and not yet notified
 * for this attempt. A plain feedback re-save of an already-announced attempt owes nothing.
 */
export function gradeCardOwed(sub: {
  score?: unknown;
  score_is_stale?: boolean | null;
  attempt_number?: number | null;
  grade_card_notified_attempt?: number | null;
}): boolean {
  if (typeof sub.score !== "number" || sub.score_is_stale === true) return false;
  const attempt = sub.attempt_number ?? 1;
  const notified = sub.grade_card_notified_attempt ?? null;
  return notified == null || notified < attempt;
}

/**
 * A grade card was owed for this graded attempt, but the student has no telegram_id, so no sender can
 * deliver it. All three senders call this with the same key and window, so an attempt yields ONE
 * grade_card_dm_skipped row whichever path sees it first, and the reconciler re-seeing it every run for
 * 14 days adds nothing. A resubmission is a new attempt, so its card is a new row. Never throws.
 */
export function recordGradeCardSkipped(
  admin: any,
  p: {
    submissionId: string;
    studentId: string | null;
    attempt: number;
    source: "telegram-bot-webhook" | "notify-grade-voice" | "grade-card-reconcile";
    actorUserId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<boolean> {
  return logHealthOnce(admin, "grade_card_dm_skipped", `no_telegram:${p.submissionId}:${p.attempt}`, {
    reason: "no_telegram", submission_id: p.submissionId, attempt: p.attempt, ...(p.details ?? {}),
  }, {
    source: p.source,
    actorUserId: p.actorUserId ?? null,
    targetUserId: p.studentId,
    targetResourceType: "homework_submission",
    targetResourceId: p.submissionId,
    sinceIso: new Date(Date.now() - GRADE_CARD_SKIP_WINDOW_DAYS * 86_400_000).toISOString(),
  });
}
