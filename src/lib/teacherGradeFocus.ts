// teacherGradeFocus — /tg/teacher/grade?sub=<submission id>: open THAT submission first.
//
// The bot's new-homework DM and the 24 h ungraded reminder carry a 🎯 Baholash web_app button to this URL
// (supabase/functions/_shared/teacher-miniapp.ts teacherGradePath). The grading queue is loaded as usual and the
// requested submission is moved to the front; the rest keep their order. When it is not in the queue (a co-teacher
// graded it first, it was returned for redo, it is another group's) the teacher is told gently and simply
// continues with the queue — member forgiveness: never an error screen. Pure — pinned by teacherGradeFocus.test.ts.
import { isUuid } from "@/lib/miniappLinks";

/** The ?sub= of a URL query, lowercased, or null when it is missing or not a UUID. */
export function readSubParam(search: string | URLSearchParams | null | undefined): string | null {
  let q: URLSearchParams;
  try {
    q = typeof search === "string" || search == null ? new URLSearchParams(search || "") : search;
  } catch {
    return null;
  }
  const v = q.get("sub");
  return isUuid(v) ? v.toLowerCase() : null;
}

/** Move the submission `subId` to the front of the queue. `found` false = it is not in the queue (unchanged). */
export function focusSubmission<T extends { submission_id: string }>(
  queue: readonly T[],
  subId: string | null | undefined,
): { queue: T[]; found: boolean } {
  if (!subId) return { queue: [...queue], found: false };
  const want = subId.toLowerCase();
  const i = queue.findIndex((q) => String(q.submission_id).toLowerCase() === want);
  if (i < 0) return { queue: [...queue], found: false };
  return { queue: [queue[i], ...queue.slice(0, i), ...queue.slice(i + 1)], found: true };
}

/** The toast for a deep-linked submission that is not in the queue. */
export function missingSubmissionMessage(state: "graded" | "unknown"): { title: string; description: string } {
  return state === "graded"
    ? { title: "Bu ish allaqachon baholangan", description: "Navbatdagi ishlar bilan davom etamiz." }
    : {
      title: "Bu ish navbatingizda yo'q",
      description: "U qaytarilgan yoki boshqa guruhga tegishli bo'lishi mumkin. Navbatdagi ishlar bilan davom etamiz.",
    };
}
