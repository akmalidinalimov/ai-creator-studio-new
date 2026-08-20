// homeworkAudio — upload/remove helpers for teacher-recorded voice feedback (Task 3 of the
// 2026-08-20 voice-homework-feedback feature).
//
// Storage shape (Task 1, supabase/migrations/20260820140000_voice_feedback_storage.sql): a
// PRIVATE `homework-audio` bucket, object key `<student_user_id>/<submission_id>.mp3`. The
// bucket's INSERT/UPDATE policy grants the STUDENT (self-folder), an admin, OR a teacher of the
// student's group (junction-aware `is_group_teacher`) — so the grading teacher's own session can
// upload directly into the student's folder; no service-role/edge fn needed for the write.
//
// Shared by every grading surface (Mini App `TeacherGrade`, web `TeacherProfile` /
// `TeacherHomework`) so the path convention + error handling live in exactly one place.
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "homework-audio";

function feedbackVoicePath(studentUserId: string, submissionId: string): string {
  return `${studentUserId}/${submissionId}.mp3`;
}

/**
 * Upload a teacher-recorded MP3 feedback note to the deterministic
 * `<student_user_id>/<submission_id>.mp3` key (upsert — a re-recording for the SAME submission
 * overwrites the prior object in place, no separate delete needed for a replace). Returns the
 * storage path to be written into `homework_submissions.score_feedback_voice_path` in the same
 * grade-write update. Throws a clear, user-facing message on failure so callers can surface it
 * (via toast) and abort the save WITHOUT writing a path that doesn't point at real audio.
 */
export async function uploadFeedbackVoice(
  studentUserId: string,
  submissionId: string,
  mp3: Blob,
): Promise<string> {
  const path = feedbackVoicePath(studentUserId, submissionId);
  const { error } = await supabase.storage.from(BUCKET).upload(path, mp3, {
    upsert: true,
    contentType: "audio/mpeg",
  });
  if (error) throw new Error(`Ovozli izohni yuklab bo'lmadi: ${error.message}`);
  return path;
}

/**
 * Best-effort delete of a feedback voice object — used when a teacher removes a prior note
 * without recording a replacement (score_feedback_voice_path is cleared to null in the same
 * grade-write). Never throws: a leftover orphaned object is harmless (nothing references it once
 * the DB column is null), so a storage hiccup here must not block or fail the grade save.
 */
export async function removeFeedbackVoice(studentUserId: string, submissionId: string): Promise<void> {
  try {
    await supabase.storage.from(BUCKET).remove([feedbackVoicePath(studentUserId, submissionId)]);
  } catch {
    /* best-effort */
  }
}
