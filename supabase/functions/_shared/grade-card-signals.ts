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

// ---- Voice feedback: the same skip, for the voice note that follows (or replaces) the card. ----
//
// Three paths deliver a teacher's voice note: bot grading (telegram-bot-webhook grade_comment), the Mini App
// voice bridge (telegram-bot-webhook grade_voice) and in-app recording (notify-grade-voice). A student who
// blocked the bot already leaves a grade_voice_delivery_failed / grade_voice_dm_failed row (recipient_error),
// but a student with no telegram_id left nothing on the bridge path, and on the other two only a flag on the
// grade_card_dm_skipped row, which exists once per attempt, so a second note on the same attempt vanished.
// A voice note gets its own row, keyed by the NOTE rather than the attempt.

/**
 * The note's identity from the teacher's Telegram message: file_unique_id of the voice (or audio), which
 * every private voice message in webhook_inbox carries (339 of 339 on 2026-09-30) and a redelivered update
 * repeats. A message without one falls back to its chat and message id.
 */
export function botVoiceKey(msg: {
  chat?: { id?: number | string } | null;
  message_id?: number | string;
  voice?: { file_unique_id?: string } | null;
  audio?: { file_unique_id?: string } | null;
}): string {
  const uid = msg.voice?.file_unique_id || msg.audio?.file_unique_id;
  if (uid) return `tg:${uid}`;
  return `tgmsg:${msg.chat?.id ?? "?"}:${msg.message_id ?? "?"}`;
}

/**
 * The note's identity on the in-app path: the scored_at of the grade write that stored it. Every app
 * grading surface (teacherApi.submitScore, TeacherProfile, TeacherHomework) sets scored_at in the same update
 * as the new voice path, so a double invoke for one save shares a key and a re-recording saved later gets
 * a new one. The storage path cannot tell them apart: it is <student>/<submission>.mp3 for every recording.
 */
export function appVoiceKey(scoredAt: string | null | undefined, attempt: number): string {
  return scoredAt ? `app:${scoredAt}` : `app:attempt${attempt}`;
}

/**
 * A voice note was recorded for this submission, but the student has no telegram_id, so it was never sent
 * (it is still saved and playable in the app). ONE grade_voice_dm_skipped row per note, whichever path
 * carried it. Expected reach like grade_card_dm_skipped: counted, never alarmed. Never throws.
 */
export function recordGradeVoiceSkipped(
  admin: any,
  p: {
    submissionId: string;
    studentId: string | null;
    voiceKey: string;
    source: "telegram-bot-webhook" | "miniapp_voice_bridge" | "notify-grade-voice";
    actorUserId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<boolean> {
  return logHealthOnce(admin, "grade_voice_dm_skipped", `no_telegram:${p.submissionId}:${p.voiceKey}`, {
    reason: "no_telegram", submission_id: p.submissionId, ...(p.details ?? {}),
  }, {
    source: p.source,
    actorUserId: p.actorUserId ?? null,
    targetUserId: p.studentId,
    targetResourceType: "homework_submission",
    targetResourceId: p.submissionId,
    sinceIso: new Date(Date.now() - GRADE_CARD_SKIP_WINDOW_DAYS * 86_400_000).toISOString(),
  });
}
