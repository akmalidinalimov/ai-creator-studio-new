// teacherApi — typed wrappers for the teacher Mini App grading flow (Phase 1, Task 6).
//
// Three concerns, all against the RLS-gated authenticated `supabase` client (the teacher's minted
// Telegram session), never a service key:
//   • fetchPendingQueue()   → the junction-scoped grading queue (RPC teacher_pending_submissions()).
//   • resolveImageUrl(id)   → a viewable <img> src via the hw-image-url edge fn (storage OR file_id).
//   • submitScore/returnForRedo → the grade WRITE + the return-for-redo re-open.
//
// GRADE-WRITE FIDELITY (the whole point): submitScore writes the EXACT same columns
// TeacherHomework.saveScore (src/pages/TeacherHomework.tsx:188) and TeacherProfile.grade
// (src/components/profile/TeacherProfile.tsx:164) write — score / score_feedback / scored_by /
// scored_at / score_is_stale=false — so the +15/+25 homework XP triggers (xp_on_homework) fire
// identically and the guard trigger behaves the same. We NEVER touch xp_events here.
import { supabase } from "@/integrations/supabase/client";

export interface QueueMedia {
  kind?: string;
  url?: string;
  msg_url?: string;
  file_id?: string;
}

// One row of teacher_pending_submissions() (20260819000000_teacher_pending_submissions.sql).
export interface PendingSubmission {
  submission_id: string;
  user_id: string;
  student_name: string;
  group_id: string;
  group_name: string;
  module_number: number;
  task_number: number;
  assignment_id: string;
  assignment_title: string;
  max_score: number;
  submitted_at: string;
  previous_score: number | null;
  is_resubmission: boolean;
  media: QueueMedia[] | null;
  submitted_image_url: string | null;
}

/**
 * The caller's pending grading queue (oldest-first), junction-scoped by the RPC itself
 * (teacher_group_ids(auth.uid())) — co-teachers get the same rows as primaries. The RPC name may
 * not be in the generated Supabase types yet → cast per the frontend-typecheck-verify convention.
 * Throws on a real transport/RPC error so the caller can render the offline/error state; an empty
 * queue is a normal [] (the end-of-queue state), never an error.
 */
export async function fetchPendingQueue(): Promise<PendingSubmission[]> {
  const { data, error } = await supabase.rpc("teacher_pending_submissions" as any);
  if (error) throw error;
  return Array.isArray(data) ? (data as unknown as PendingSubmission[]) : [];
}

export type ImageResolution = { url: string } | { url: null; reason: string };

/**
 * Resolve a submission's viewable image URL via the hw-image-url edge fn. Returns a discriminated
 * result — a usable src, or {url:null, reason} for the (COMMON, not edge-case) degraded state.
 * Never throws: a transport/gateway/403 error resolves to a degraded reason so GradePhoto always
 * renders the "open in Telegram" fallback instead of crashing the card.
 */
export async function resolveImageUrl(submissionId: string): Promise<ImageResolution> {
  try {
    const { data, error } = await supabase.functions.invoke("hw-image-url", {
      body: { submission_id: submissionId },
    });
    if (error) return { url: null, reason: "request_failed" };
    const url = (data as any)?.url ?? null;
    if (typeof url === "string" && url) return { url };
    return { url: null, reason: (data as any)?.reason || "no_viewable_media" };
  } catch {
    return { url: null, reason: "request_failed" };
  }
}

export type SubmitResult =
  | { status: "ok" }
  | { status: "already_graded" }
  | { status: "error"; message: string };

/**
 * Write a grade. Mirrors TeacherHomework.saveScore's columns EXACTLY (score, score_feedback,
 * scored_by=auth.uid(), scored_at=now(), score_is_stale=false) so XP + the guard trigger behave
 * identically — see the file header. `voicePath` (Task 3, voice-homework-feedback) is purely
 * ADDITIVE, with "undefined = preserve" semantics (fix round 1): pass the newly-uploaded path to
 * SET it, `null` to explicitly CLEAR it, or omit the argument entirely to leave whatever
 * `score_feedback_voice_path` already has untouched. This matters because the Mini App caller
 * (TeacherGrade.tsx) never loads the existing path — its RPC doesn't return it — so a plain
 * regrade without touching voice must NOT silently null out a note from an earlier round. It
 * changes nothing about the five columns above, the ownership guard below, or the undo semantics.
 *
 * Concurrent-claim guard (member-forgiveness / "boshqa ustoz baholadi"): a fresh pre-read detects
 * whether ANOTHER teacher graded this submission between load and now. "Already graded by another"
 * = a real finished grade (score set AND not stale) stamped by a different uid. A resubmission
 * (score present but score_is_stale=true) is still PENDING → not flagged, we proceed. Our own uid
 * (e.g. after an undo→regrade) is never flagged → we may overwrite our own grade silently. There is
 * a tiny check→write race window; last-write-wins is acceptable here (rare, forgiving, no data loss).
 */
export async function submitScore(
  submissionId: string,
  score: number,
  feedback: string,
  voicePath?: string | null,
): Promise<SubmitResult> {
  const { data: authData } = await supabase.auth.getUser();
  const uid = authData?.user?.id ?? null;

  const { data: cur } = await supabase
    .from("homework_submissions")
    .select("score, score_is_stale, scored_by")
    .eq("id", submissionId)
    .maybeSingle();
  const c = cur as { score: number | null; score_is_stale: boolean | null; scored_by: string | null } | null;
  if (c && c.score != null && c.score_is_stale === false && c.scored_by && c.scored_by !== uid) {
    return { status: "already_graded" };
  }

  const trimmed = feedback.trim();
  const update: Record<string, unknown> = {
    score,
    score_feedback: trimmed ? trimmed : null,
    scored_by: uid,
    scored_at: new Date().toISOString(),
    score_is_stale: false,
  };
  // Fix round 1 (Important A): only touch the voice column when the caller actually provided a
  // value. `voicePath === undefined` (the Mini App's default when it didn't record/replace a note
  // this round) means "leave score_feedback_voice_path exactly as it is" — a plain regrade must
  // never silently null out a note from an earlier round just because this caller can't see it.
  if (voicePath !== undefined) update.score_feedback_voice_path = voicePath;

  const { error } = await supabase
    .from("homework_submissions")
    // score_feedback_voice_path is not in the generated types yet (Task 1's migration), hence the
    // `as any` cast on the whole payload.
    .update(update as any)
    .eq("id", submissionId);
  if (error) return { status: "error", message: error.message };
  return { status: "ok" };
}

/**
 * Fire-and-forget push of a Telegram audio DM for a voice feedback note JUST uploaded this grading
 * round (Task 6, voice-homework-feedback). Called from all three grading surfaces (TeacherGrade,
 * TeacherHomework, TeacherProfile) right after their grade-write succeeds — NEVER awaited, NEVER
 * allowed to fail the grade: the notify-grade-voice edge fn itself is fully graceful (a student with
 * no telegram_id, a blocked bot, or a Telegram hiccup all resolve to `{ok:true, sent:false}` there),
 * and this wrapper swallows any transport error on top of that so a network blip can't even surface
 * a console warning mid-grading-flow. The in-app player (Task 5 / hw-audio-url) is the durable
 * delivery path for every student regardless of whether this push lands.
 */
export function notifyGradeVoice(submissionId: string): void {
  void supabase.functions
    .invoke("notify-grade-voice", { body: { submission_id: submissionId } })
    .catch(() => {});
}

// NOTE: there is deliberately NO `undoScore` that clears score→null. The homework_submissions_guard
// trigger (20260509085603_...sql) only permits OLD.score→NULL when attempt_number is ALSO bumped (a
// resubmission); a plain null-clear is SILENTLY reverted (`NEW.score := OLD.score`) while our
// scored_by/scored_at stay NULL → an orphaned score that disappears from every grading queue yet
// keeps its homework XP forever (the reconciler is INSERT-ONLY; it never retracts hw_score:<id>).
// Supabase still returns success, so the UI would falsely believe it undid. The Mini App's "Ortga"
// is instead a purely client-side RE-OPEN-TO-CORRECT (see TeacherGrade.tsx): it re-presents the
// just-graded item and the teacher re-submits via submitScore — a safe score-CHANGE (non-null→
// non-null, guard-allowed; XP ref-keyed idempotent). No score-clear write ever happens.

/**
 * Return a submission to the student for redo. Mirrors TeacherHomework.reset — the
 * start_homework_resubmission RPC (junction-aware teacher branch since #86, so co-teachers are
 * authorized) bumps attempt_number, snapshots a scored attempt, and re-opens it.
 */
export async function returnForRedo(submissionId: string): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase.rpc("start_homework_resubmission" as any, {
    p_submission_id: submissionId,
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}
