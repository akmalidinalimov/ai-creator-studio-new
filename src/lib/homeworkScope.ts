/**
 * Which course(s) a student's homework summary (Settings → "Uy vazifalari") covers.
 *
 * WHY: the section used to read `groups.course_id` straight from the client. `groups` is admin-only
 * under RLS, so for a student that read ALWAYS returned null and the section silently fell back to
 * every enrolled course — and with no enrollment at all it dropped the course filter entirely and
 * listed EVERY published course's homework (27 paid students with no group saw 5.0 + Challenge 6.0,
 * "0/18"). A student moved between courses keeps both enrollments (sync_group_enrollment only adds),
 * so they would see both courses mixed into one total.
 *
 * RULE: the group's course, resolved server-side by group_rating_course_id(uid) (SECURITY DEFINER,
 * self-or-admin gate — the same lookup the Reyting screen uses). Only a student WITHOUT a group course
 * falls back to their own enrollments, and no course at all means an empty list, never "all courses".
 */
import { reportClientError } from "@/lib/beacon";

export type HomeworkScope = { courseIds: string[]; source: "group" | "enrollments" | "none" };

export async function resolveHomeworkCourseIds(client: any, userId: string): Promise<HomeworkScope> {
  let groupCourse: string | null = null;
  try {
    const { data, error } = await client.rpc("group_rating_course_id", { uid: userId });
    if (error) {
      // Degrades to the enrollment fallback (the pre-fix behaviour) — beaconed, not hidden.
      reportClientError({ type: "other", message: "homework_scope_unresolved", extra: { code: error.code ?? error.message ?? null } });
    } else if (typeof data === "string" && data) {
      groupCourse = data;
    }
  } catch (e: any) {
    reportClientError({ type: "other", message: "homework_scope_unresolved", extra: { code: String(e?.message ?? e) } });
  }
  if (groupCourse) return { courseIds: [groupCourse], source: "group" };

  const { data: enr, error: enrErr } = await client.from("enrollments").select("course_id").eq("user_id", userId);
  if (enrErr) {
    reportClientError({ type: "other", message: "homework_scope_unresolved", extra: { step: "enrollments", code: enrErr.code ?? enrErr.message ?? null } });
  }
  const ids = Array.from(new Set(((enr as any[]) || []).map((r) => r?.course_id).filter((x): x is string => typeof x === "string" && !!x)));
  return { courseIds: ids, source: ids.length ? "enrollments" : "none" };
}
