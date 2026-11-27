// MULTI-COURSE STUDENTS in the bot (PR 3b of 4, teacher side).
//
// A homework belongs to the student's group IN THE TASK'S COURSE (student_course_groups, is_main = false), else to
// their main group (profiles.group_id) — the SQL rule homework_group_for_submission (PR 2), groupForTaskCourse in
// multi-course.ts. A teacher's bot lists (grading picker, roster, module views) used to scope by "students whose
// profiles.group_id is one of my groups", so a second course's teacher never saw that work and the main-group
// teacher saw it instead. This file is the pure, CI-tested rule those lists now share:
//
//   - buildTeacherScope()   the students a teacher may see (main group ∪ secondary group in the teacher's groups) plus
//                           what is needed to place each SUBMISSION: their main group and their secondary rows.
//   - submissionGroupOf()   the group of one submission (user, task course), from that scope.
//   - inTeacherScope()      is that group one of the teacher's groups.
//   - scopeSubmissions()    filter a batch of submissions (needs the task course only for students with a
//                           secondary course; everyone else is placed in their main group with no lookup).
//
// For a student with no secondary course (99%) a submission's group is their main group, so every list is exactly
// what it was before.

export type ScopeMainRow = { id: string; group_id: string | null };
export type ScopeSecondaryRow = { user_id: string; course_id: string; group_id: string };

export type TeacherScope = {
  /** The groups the lists are scoped to (the teacher's groups, or the one chosen group). */
  groupIds: string[];
  /** Candidate students: main group in groupIds, then those whose SECONDARY group is in groupIds. */
  studentIds: string[];
  /** Main group of the main-group students. A secondary-only student is absent (their main group is not ours). */
  main: Map<string, string | null>;
  /** Secondary course rows per student (only students that have one). */
  secondary: Map<string, { course_id: string; group_id: string }[]>;
};

export function buildTeacherScope(
  groupIds: readonly string[],
  mainRows: readonly ScopeMainRow[],
  secondaryRows: readonly ScopeSecondaryRow[],
): TeacherScope {
  const gids = Array.from(new Set(groupIds.filter(Boolean).map(String)));
  const gset = new Set(gids);
  const main = new Map<string, string | null>();
  const studentIds: string[] = [];
  for (const r of mainRows) {
    if (!r?.id || !r.group_id || !gset.has(String(r.group_id)) || main.has(r.id)) continue;
    main.set(r.id, String(r.group_id));
    studentIds.push(r.id);
  }
  const secondary = new Map<string, { course_id: string; group_id: string }[]>();
  for (const r of secondaryRows) {
    if (!r?.user_id || !r.course_id || !r.group_id) continue;
    const arr = secondary.get(r.user_id) ?? [];
    if (arr.some((x) => x.course_id === r.course_id)) continue; // one group per (student, course)
    arr.push({ course_id: String(r.course_id), group_id: String(r.group_id) });
    secondary.set(r.user_id, arr);
  }
  for (const [uid, rows] of secondary) {
    if (!main.has(uid) && rows.some((x) => gset.has(x.group_id))) studentIds.push(uid);
  }
  return { groupIds: gids, studentIds, main, secondary };
}

/**
 * The group of a submission of `userId` on a task of `taskCourseId`: that course's secondary group, else the main
 * group. null = the main group is not one of the scope's groups (a secondary-only student's other course) or unknown.
 */
export function submissionGroupOf(scope: TeacherScope, userId: string, taskCourseId: string | null | undefined): string | null {
  if (taskCourseId) {
    const s = scope.secondary.get(userId)?.find((x) => x.course_id === taskCourseId);
    if (s) return s.group_id;
  }
  return scope.main.get(userId) ?? null;
}

export function inTeacherScope(scope: TeacherScope, userId: string, taskCourseId: string | null | undefined): boolean {
  const g = submissionGroupOf(scope, userId, taskCourseId);
  return !!g && scope.groupIds.includes(g);
}

/** Does this student have a secondary course (= their submissions need the task course to be placed)? */
export function needsTaskCourse(scope: TeacherScope, userId: string): boolean {
  return (scope.secondary.get(userId)?.length ?? 0) > 0;
}

/** The assignment ids whose course must be read to place these submissions (students with a secondary course only). */
export function assignmentsNeedingCourse(scope: TeacherScope, subs: readonly { user_id: string; assignment_id: string }[]): string[] {
  const out = new Set<string>();
  for (const s of subs) if (s?.assignment_id && needsTaskCourse(scope, s.user_id)) out.add(s.assignment_id);
  return Array.from(out);
}

/**
 * The submissions of this scope, each with its group. `courseOf` maps assignment id → task course (only needed for
 * students with a secondary course; a missing entry = unknown course = the main group, as the SQL rule falls back).
 */
export function scopeSubmissions<T extends { user_id: string; assignment_id: string }>(
  scope: TeacherScope,
  subs: readonly T[],
  courseOf: ReadonlyMap<string, string | null>,
): { sub: T; groupId: string }[] {
  const out: { sub: T; groupId: string }[] = [];
  for (const s of subs) {
    const course = needsTaskCourse(scope, s.user_id) ? (courseOf.get(s.assignment_id) ?? null) : null;
    const g = submissionGroupOf(scope, s.user_id, course);
    if (g && scope.groupIds.includes(g)) out.push({ sub: s, groupId: g });
  }
  return out;
}
