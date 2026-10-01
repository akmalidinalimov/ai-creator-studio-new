// teacher-group-lines — "one line per group, with its course" under a teacher's digest and nudge counts.
//
//   📥 Baholanmagan vazifalar: 5 (eng eskisi 26 soat)
//      • 5.0 · 1-GURUH PRE — 3
//      • CH6 · 3-GURUH — 2
//
// WHY: a teacher of two groups (or two courses) got one merged number ("📥 Baholanmagan vazifalar: 9",
// "N ta talaba javob kutmoqda … Guruhingizga o'tib") and could not tell which group or course was behind
// (teacher audit 2026-09-30, BOT-6). The rows come from teacher_group_signals() (daily digest, nudge) or
// teacher_groups() (weekly digest): the same SQL that produces the total, so the lines add up to it.
//
// Pure: no I/O. The caller escapes for its parse mode (every caller here sends Telegram HTML).
import { courseShort, scopeTag } from "./hw-label.ts";

export type TeacherGroupRow = {
  teacher_id: string;
  group_id: string;
  group_name: string | null;
  course_title: string | null;
  pending_homework?: number | null;
  waiting_questions?: number | null;
};

export type Loc = "uz" | "ru" | "en";

/** At most this many group lines; the rest fold into one "… +N" line. */
export const MAX_GROUP_LINES = 6;

/** "5.0 · 1-GURUH PRE" (course short + group, hw-label's scopeTag); the bare group name without a course; "—". */
export function groupLabel(courseTitle: string | null | undefined, groupName: string | null | undefined): string {
  return scopeTag(courseTitle, groupName) || String(groupName ?? "").replace(/\s+/g, " ").trim() || "—";
}

/** The board-card order (teacher-daily-digest): course short, then the label. */
export function compareGroups(a: Pick<TeacherGroupRow, "course_title" | "group_name">,
  b: Pick<TeacherGroupRow, "course_title" | "group_name">): number {
  return courseShort(a.course_title).localeCompare(courseShort(b.course_title)) ||
    groupLabel(a.course_title, a.group_name).localeCompare(groupLabel(b.course_title, b.group_name));
}

/** teacher id -> that teacher's rows, in compareGroups order. Rows without a teacher or group id are dropped. */
export function rowsByTeacher<T extends TeacherGroupRow>(rows: readonly T[] | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows ?? []) {
    if (!r?.teacher_id || !r.group_id) continue;
    const list = out.get(r.teacher_id) ?? [];
    list.push(r);
    out.set(r.teacher_id, list);
  }
  for (const list of out.values()) list.sort(compareGroups);
  return out;
}

const MORE: Record<Loc, (n: number) => string> = {
  uz: (n) => `… yana ${n} ta guruh`,
  ru: (n) => `… ещё групп: ${n}`,
  en: (n) => `… ${n} more group${n === 1 ? "" : "s"}`,
};

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * One indented bullet per group whose `pick(row)` is above 0, in board order:
 *   "   • 5.0 · 1-GURUH PRE — 3"
 * `esc` escapes the label for the message's parse mode. At most `max` lines, then one "… +N" line.
 * [] when no group has anything (the caller then prints its total alone, exactly as before).
 */
export function countLines<T extends TeacherGroupRow>(
  rows: readonly T[] | null | undefined,
  pick: (r: T) => unknown,
  opts: { esc: (s: string) => string; loc: Loc; max?: number },
): string[] {
  const max = Math.max(1, opts.max ?? MAX_GROUP_LINES);
  const hit = [...(rows ?? [])].filter((r) => count(pick(r)) > 0).sort(compareGroups);
  const shown = hit.length > max ? hit.slice(0, max - 1) : hit;
  const lines = shown.map((r) => `   • ${opts.esc(groupLabel(r.course_title, r.group_name))} — ${count(pick(r))}`);
  if (hit.length > shown.length) lines.push(`   • ${MORE[opts.loc](hit.length - shown.length)}`);
  return lines;
}

/** For a notifications_log payload: [{ group_id, n }] of the groups that had anything. */
export function countPayload<T extends TeacherGroupRow>(rows: readonly T[] | null | undefined, pick: (r: T) => unknown) {
  return [...(rows ?? [])].filter((r) => count(pick(r)) > 0).map((r) => ({ group_id: r.group_id, n: count(pick(r)) }));
}
