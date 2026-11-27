// Pins the teacher side of multi-course students (PR 3b): a submission belongs to the student's group in the TASK's
// course, else their main group, and a teacher's bot lists keep exactly the submissions of their own groups.
// Run: deno test supabase/functions/telegram-bot-webhook/teacher-course-scope.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assignmentsNeedingCourse, buildTeacherScope, inTeacherScope, scopeSubmissions, submissionGroupOf,
} from "./teacher-course-scope.ts";

const MAIN_G = "11111111-1111-1111-1111-111111111111"; // 7.0 group (main)
const SEC_G = "22222222-2222-2222-2222-222222222222"; // CLAUDE STUDIO group (secondary)
const OTHER_G = "33333333-3333-3333-3333-333333333333";
const C_MAIN = "c0000000-0000-0000-0000-00000000000a";
const C_SEC = "c0000000-0000-0000-0000-00000000000b";
const C_OLD = "c0000000-0000-0000-0000-00000000000c"; // an old course (e.g. 5.0 before a move)
const SOLO = "u0000000-0000-0000-0000-000000000001"; // single-course student in MAIN_G
const DUO = "u0000000-0000-0000-0000-000000000002"; // main MAIN_G, secondary SEC_G
const A_MAIN = "a-main", A_SEC = "a-sec", A_OLD = "a-old";
const courseOf = new Map<string, string | null>([[A_MAIN, C_MAIN], [A_SEC, C_SEC], [A_OLD, C_OLD]]);

const mains = [{ id: SOLO, group_id: MAIN_G }, { id: DUO, group_id: MAIN_G }];
const secRows = [{ user_id: DUO, course_id: C_SEC, group_id: SEC_G }];

// what loadGradingScope reads for each teacher: main members of their groups, secondary rows in their groups, and
// the secondary rows of their main members
const mainTeacher = buildTeacherScope([MAIN_G], mains, secRows);
const secTeacher = buildTeacherScope([SEC_G], [], secRows);

Deno.test("single-course submission → main group", () => {
  assertEquals(submissionGroupOf(mainTeacher, SOLO, C_MAIN), MAIN_G);
  assertEquals(submissionGroupOf(mainTeacher, SOLO, C_SEC), MAIN_G); // no row in that course → main
});

Deno.test("second-course submission → the secondary group", () => {
  assertEquals(submissionGroupOf(mainTeacher, DUO, C_SEC), SEC_G);
  assertEquals(submissionGroupOf(secTeacher, DUO, C_SEC), SEC_G);
  assertEquals(submissionGroupOf(mainTeacher, DUO, C_MAIN), MAIN_G);
});

Deno.test("old-course task → main group", () => {
  assertEquals(submissionGroupOf(mainTeacher, DUO, C_OLD), MAIN_G);
  assertEquals(submissionGroupOf(mainTeacher, SOLO, C_OLD), MAIN_G);
  assertEquals(submissionGroupOf(mainTeacher, DUO, null), MAIN_G); // unknown task course → main (SQL fallback)
});

Deno.test("the secondary group's teacher sees it, the main-group teacher does not", () => {
  assertEquals(inTeacherScope(secTeacher, DUO, C_SEC), true);
  assertEquals(inTeacherScope(mainTeacher, DUO, C_SEC), false);
  // …and the other way round for the main course and old courses
  assertEquals(inTeacherScope(mainTeacher, DUO, C_MAIN), true);
  assertEquals(inTeacherScope(mainTeacher, DUO, C_OLD), true);
  assertEquals(inTeacherScope(secTeacher, DUO, C_MAIN), false);
  assertEquals(inTeacherScope(secTeacher, DUO, C_OLD), false);
});

Deno.test("student lists: main members, plus secondary members of the teacher's group", () => {
  assertEquals(mainTeacher.studentIds, [SOLO, DUO]);
  assertEquals(secTeacher.studentIds, [DUO]);
  assertEquals(buildTeacherScope([OTHER_G], [], secRows).studentIds, []);
  assertEquals(buildTeacherScope([], mains, secRows).studentIds, []);
});

Deno.test("scopeSubmissions: per teacher, each submission once, with its group", () => {
  const subs = [
    { id: "s1", user_id: SOLO, assignment_id: A_MAIN },
    { id: "s2", user_id: DUO, assignment_id: A_MAIN },
    { id: "s3", user_id: DUO, assignment_id: A_SEC },
    { id: "s4", user_id: DUO, assignment_id: A_OLD },
  ];
  assertEquals(scopeSubmissions(mainTeacher, subs, courseOf).map((x) => [x.sub.id, x.groupId]),
    [["s1", MAIN_G], ["s2", MAIN_G], ["s4", MAIN_G]]);
  assertEquals(scopeSubmissions(secTeacher, subs, courseOf).map((x) => [x.sub.id, x.groupId]), [["s3", SEC_G]]);
  // a teacher of BOTH groups sees all four, each in its own group
  const both = buildTeacherScope([MAIN_G, SEC_G], mains, secRows);
  assertEquals(scopeSubmissions(both, subs, courseOf).map((x) => [x.sub.id, x.groupId]),
    [["s1", MAIN_G], ["s2", MAIN_G], ["s3", SEC_G], ["s4", MAIN_G]]);
});

Deno.test("single-course students need no task-course read; unknown course falls back to main", () => {
  const subs = [{ user_id: SOLO, assignment_id: A_MAIN }, { user_id: DUO, assignment_id: A_SEC }];
  assertEquals(assignmentsNeedingCourse(mainTeacher, subs), [A_SEC]);
  const solo = buildTeacherScope([MAIN_G], [{ id: SOLO, group_id: MAIN_G }], []);
  assertEquals(assignmentsNeedingCourse(solo, [{ user_id: SOLO, assignment_id: A_MAIN }]), []);
  // empty course map (a failed read): every submission is placed in the main group, the pre-multi-course answer
  assertEquals(scopeSubmissions(mainTeacher, subs, new Map()).map((x) => x.groupId), [MAIN_G, MAIN_G]);
  assertEquals(scopeSubmissions(secTeacher, subs, new Map()).length, 0);
});

Deno.test("a duplicate secondary row for the same course is ignored (one group per course)", () => {
  const s = buildTeacherScope([SEC_G], [], [...secRows, { user_id: DUO, course_id: C_SEC, group_id: OTHER_G }]);
  assertEquals(submissionGroupOf(s, DUO, C_SEC), SEC_G);
});
