// Bot-side texts that carry the shared homework label (_shared/hw-label.ts):
//   "<course> · <group> · M<n> V<step> — <title>"
// The Challenge 6.0 tasks are copies of the 5.0 tasks, so a grading header, a score prompt or a new-homework DM
// that names only the student and the task title cannot say which course or group the work belongs to
// (teacher audit 2026-09-30: BOT-3, BOT-4, BOT-8). Pure; tested in hw-labels.test.ts. Inputs are raw text;
// every function here escapes for parse_mode=HTML.
import { courseShort, scopeTag } from "../_shared/hw-label.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Session context is untyped jsonb: anything that is not a string counts as absent.
const trim = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/**
 * "👤 <b>Aziza Karimova</b> · 5.0 · 1-GURUH PRE · M2 V1": who the next score / comment / voice note goes to.
 * "" when there is no name (a session parked before this change, or by the retag path).
 */
export function gradeWhoLine(studentName: string | null | undefined, tag: string | null | undefined): string {
  const n = trim(studentName);
  if (!n) return "";
  const t = trim(tag);
  return `👤 <b>${esc(n)}</b>${t ? ` · ${esc(t)}` : ""}`;
}

/** `text` with the who-line above it; `text` unchanged when there is no who-line. */
export function withWho(text: string, studentName: string | null | undefined, tag: string | null | undefined): string {
  const w = gradeWhoLine(studentName, tag);
  return w ? `${w}\n${text}` : text;
}

/** `text` with the who-line below it (the "saved" confirmations); unchanged when there is none. */
export function thenWho(text: string, studentName: string | null | undefined, tag: string | null | undefined): string {
  const w = gradeWhoLine(studentName, tag);
  return w ? `${text}\n${w}` : text;
}

/** `text` with a "📌 <label>" line below it; unchanged when there is no label. */
export function withLabelLine(text: string, label: string | null | undefined): string {
  const l = trim(label);
  return l ? `${text}\n📌 ${esc(l)}` : text;
}

/**
 * The grading screen header: the student, then the full label. When the label could not be read, the old
 * one-liner "<b>name</b> — title #step" (fallbackTitle is the raw "title #step").
 */
export function gradingHeader(studentName: string | null | undefined, label: string | null | undefined, fallbackTitle: string): string {
  const n = esc(trim(studentName) || "—");
  const l = trim(label);
  return l ? `<b>${n}</b>\n📌 ${esc(l)}` : `<b>${n}</b> — ${esc(fallbackTitle)}`;
}

/** The immediate new-homework DM to each teacher of the group (notifyTeachersOfSubmission). */
export function hwTeacherBody(studentName: string, label: string): string {
  return `🆕 <b>Yangi vazifa topshirildi</b>\n👤 Talaba: <b>${esc(studentName)}</b>\n📌 <b>${esc(label || "—")}</b>\n\nXabarni topikda ko'ring va baholang.`;
}

/** The student-breakdown header's second line: "👥 5.0 · 1-GURUH PRE". "" when the student has no group. */
export function breakdownScopeLine(groupCourseTitle: string | null | undefined, groupName: string | null | undefined): string {
  if (!trim(groupName)) return "";
  const s = scopeTag(groupCourseTitle, groupName);
  return s ? `👥 ${esc(s)}` : "";
}

/**
 * A breakdown module header's course marker: " · 5.0" when the module's course differs from the student's
 * group's course (old-course work after a move), else "". Same course, or either one unknown → "".
 */
export function moduleCourseMark(moduleCourseTitle: string | null | undefined, groupCourseTitle: string | null | undefined): string {
  const m = courseShort(moduleCourseTitle);
  const g = courseShort(groupCourseTitle);
  return m && g && m !== g ? ` · ${esc(m)}` : "";
}
