// gradeFilter — the Baholash (/tg/teacher/grade) course + group filter, as pure functions (teacher audit PR-4,
// TUI-1). A teacher of both AI Creators 5.0 and Challenge 6.0 used to get one mixed queue she could not split.
//
// THE RULES
//   • The course of a row is its TASK's course (row.course_id, from the RPC); the group is the student's current
//     group (row.group_id) — the same scope the queue itself uses.
//   • "Hammasi" (no filter) is the default and is never persisted: the grading screen must never quietly hide work
//     because of a pick made on another screen or yesterday ("grading never hides work", as /baholash does). A
//     filter lives in the URL (?course= / ?group=), so a link from Home can open a course directly.
//   • Chips come from what the teacher has SEEN this session (the queue plus the items she already handled), so a
//     course or group she has just emptied keeps its chip at 0 instead of vanishing under her finger.
//   • A filter naming a course or group that is not there (a stale link) is ignored: the page shows everything.
//   • The course row shows only when there are two or more courses, the group row only with two or more groups
//     (a one-group teacher sees no filter bar at all) — or when a filter on that row is in force, so "Hammasi" is
//     always one tap away.
import { courseShort, groupShort, scopeTag } from "@/lib/hwLabel";

export interface GradeFilter {
  courseId: string | null;
  groupId: string | null;
}

export const NO_FILTER: GradeFilter = { courseId: null, groupId: null };

/** The row fields the filter reads (a subset of PendingSubmission). */
export interface GradeFilterRow {
  submission_id: string;
  group_id: string;
  group_name: string;
  course_id?: string | null;
  course_title?: string | null;
}

/** A teacher's group as useSelectedGroup maps teacher_groups(uid). */
export interface GradeFilterGroup {
  id: string;
  name: string;
  courseName: string | null;
}

export interface CourseOption {
  id: string;
  title: string | null;
  /** "5.0" / "CH6" (the shared label's course short) */
  short: string;
  count: number;
}

export interface GroupOption {
  id: string;
  /** "1-GURUH VIP" inside a course; "5.0 · 1-GURUH VIP" when all courses are listed together */
  label: string;
  /** the course of the GROUP (for its colour dot); null when unknown */
  courseTitle: string | null;
  count: number;
}

export interface GradeFilterModel<R extends GradeFilterRow> {
  /** the filter actually applied (ids that are not there are dropped) */
  filter: GradeFilter;
  /** everything waiting — the "Hammasi" count */
  total: number;
  courses: CourseOption[];
  groups: GroupOption[];
  showCourses: boolean;
  showGroups: boolean;
  /** the queue under the filter, in queue order */
  visible: R[];
}

export function matchesFilter(r: GradeFilterRow, f: GradeFilter): boolean {
  if (f.courseId && r.course_id !== f.courseId) return false;
  if (f.groupId && r.group_id !== f.groupId) return false;
  return true;
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * @param queue  the items still waiting, in queue order (the counts and `visible`)
 * @param seen   every item seen this session, handled ones included (which chips exist)
 * @param groups the teacher's groups (useSelectedGroup), so a group with nothing waiting still has its chip
 */
export function buildGradeFilter<R extends GradeFilterRow>(
  queue: R[],
  seen: GradeFilterRow[],
  groups: GradeFilterGroup[],
  wanted: GradeFilter,
): GradeFilterModel<R> {
  const all: GradeFilterRow[] = [...queue, ...seen];

  // Courses: every course a seen item belongs to.
  const courseTitles = new Map<string, string | null>();
  for (const r of all) if (r.course_id && !courseTitles.has(r.course_id)) courseTitles.set(r.course_id, r.course_title ?? null);
  const courses: CourseOption[] = [...courseTitles].map(([id, title]) => ({
    id,
    title,
    short: courseShort(title) || "?",
    count: queue.filter((r) => r.course_id === id).length,
  }));
  courses.sort((a, b) => byText(a.short, b.short));
  const course = wanted.courseId ? courses.find((c) => c.id === wanted.courseId) ?? null : null;

  // Groups: the teacher's groups (of the chosen course), plus any group a seen item of that course is in (a moved
  // student's old-course work sits under the new group).
  const inCourse = (r: GradeFilterRow) => !course || r.course_id === course.id;
  const groupCourse = new Map(groups.map((g) => [g.id, g.courseName ?? null]));
  // A chip names the group's own course when more than one course is on the row, or when the group is not of the
  // chosen course (a moved student's old-course work): "CH6 · 3-GURUH" under 5.0, never a bare "3-GURUH".
  const multiCourse = !course && courses.length >= 2;
  const label = (name: string, courseTitle: string | null) => {
    const foreign = !!course && courseTitle !== null && courseTitle !== course.title;
    return ((multiCourse || foreign) ? scopeTag(courseTitle, name) : groupShort(name, courseTitle)) || name;
  };
  const opts = new Map<string, GroupOption>();
  for (const g of groups) {
    if (course && (g.courseName ?? null) !== course.title) continue;
    opts.set(g.id, { id: g.id, label: label(g.name, g.courseName ?? null), courseTitle: g.courseName ?? null, count: 0 });
  }
  for (const r of all) {
    if (!inCourse(r) || opts.has(r.group_id)) continue;
    const ct = groupCourse.get(r.group_id) ?? null;
    opts.set(r.group_id, { id: r.group_id, label: label(r.group_name, ct), courseTitle: ct, count: 0 });
  }
  for (const r of queue) {
    if (!inCourse(r)) continue;
    const o = opts.get(r.group_id);
    if (o) o.count += 1;
  }
  const groupOpts = [...opts.values()].sort((a, b) => byText(a.label, b.label));
  const group = wanted.groupId ? groupOpts.find((g) => g.id === wanted.groupId) ?? null : null;

  const filter: GradeFilter = { courseId: course?.id ?? null, groupId: group?.id ?? null };
  return {
    filter,
    total: queue.length,
    courses,
    groups: groupOpts,
    // An active filter always shows its row, so "Hammasi" is always one tap away.
    showCourses: courses.length >= 2 || filter.courseId !== null,
    showGroups: groupOpts.length >= 2 || filter.groupId !== null,
    visible: queue.filter((r) => matchesFilter(r, filter)),
  };
}

/** The waiting items per course (TeacherHome's per-course counts): rows with no known course are left out. */
export function countByCourse(rows: GradeFilterRow[]): CourseOption[] {
  const out = new Map<string, CourseOption>();
  for (const r of rows) {
    if (!r.course_id) continue;
    const o = out.get(r.course_id) ?? { id: r.course_id, title: r.course_title ?? null, short: courseShort(r.course_title) || "?", count: 0 };
    o.count += 1;
    out.set(r.course_id, o);
  }
  return [...out.values()].sort((a, b) => byText(a.short, b.short));
}

/** ?course=<id>&group=<id> → a filter (ids unchecked here; buildGradeFilter drops ones that are not there). */
export function filterFromSearch(params: URLSearchParams): GradeFilter {
  return { courseId: params.get("course") || null, groupId: params.get("group") || null };
}

/** A filter → the search params that carry it (empty for "Hammasi"). */
export function searchFromFilter(f: GradeFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.courseId) out.course = f.courseId;
  if (f.groupId) out.group = f.groupId;
  return out;
}
