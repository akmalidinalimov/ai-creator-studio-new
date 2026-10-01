import { describe, it, expect } from "vitest";
import {
  NO_FILTER,
  buildGradeFilter,
  countByCourse,
  filterFromSearch,
  matchesFilter,
  searchFromFilter,
  type GradeFilterRow,
} from "@/lib/gradeFilter";

// The Baholash course + group filter (teacher audit PR-4, TUI-1). Fixtures are the live course and group names.
const C5 = { id: "c5", title: "AI CREATORS 5.0" };
const C6 = { id: "c6", title: "AI CREATORS CHALLENGE 6.0" };
const G5A = { id: "g5a", name: "1-GURUH VIP 5.0", courseName: C5.title };
const G5B = { id: "g5b", name: "2-GURUH VIP 5.0", courseName: C5.title };
const G6 = { id: "g6", name: "AC CHALLENGE | 3-GURUH", courseName: C6.title };
const G6X = { id: "g6x", name: "AC CHALLENGE | 4-GURUH", courseName: C6.title };

const r = (id: string, g: { id: string; name: string }, c: { id: string; title: string } | null): GradeFilterRow => ({
  submission_id: id, group_id: g.id, group_name: g.name, course_id: c?.id ?? null, course_title: c?.title ?? null,
});

// A teacher of 5.0 (two groups) and 6.0 (one group, empty); s5 is a moved student's 5.0 task under the 6.0 group.
const QUEUE = [r("s1", G5A, C5), r("s2", G5B, C5), r("s3", G5B, C5), r("s4", G6, C6), r("s5", G6, C5)];
const GROUPS = [G5A, G5B, G6, G6X];

describe("buildGradeFilter", () => {
  it("no filter: everything visible, in queue order; a course chip per course with its count", () => {
    const m = buildGradeFilter(QUEUE, [], GROUPS, NO_FILTER);
    expect(m.visible.map((x) => x.submission_id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(m.total).toBe(5);
    expect(m.courses.map((c) => [c.short, c.count])).toEqual([["5.0", 4], ["CH6", 1]]);
    expect(m.showCourses).toBe(true);
  });

  it("no filter across two courses: group chips carry the course ('5.0 · 1-GURUH VIP'); an empty group keeps its chip at 0", () => {
    const m = buildGradeFilter(QUEUE, [], GROUPS, NO_FILTER);
    expect(m.groups.map((g) => [g.label, g.count])).toEqual([
      ["5.0 · 1-GURUH VIP", 1], ["5.0 · 2-GURUH VIP", 2], ["CH6 · 3-GURUH", 2], ["CH6 · 4-GURUH", 0],
    ]);
  });

  it("a course: only its TASKS (a moved student's 5.0 task counts under 5.0), and its groups by their short name", () => {
    const m = buildGradeFilter(QUEUE, [], GROUPS, { courseId: "c5", groupId: null });
    expect(m.visible.map((x) => x.submission_id)).toEqual(["s1", "s2", "s3", "s5"]);
    // 3-GURUH is a 6.0 group but holds a 5.0 task, so it is listed under 5.0 too — named with its own course.
    expect(m.groups.map((g) => [g.label, g.count])).toEqual([["1-GURUH VIP", 1], ["2-GURUH VIP", 2], ["CH6 · 3-GURUH", 1]]);
    const m6 = buildGradeFilter(QUEUE, [], GROUPS, { courseId: "c6", groupId: null });
    expect(m6.visible.map((x) => x.submission_id)).toEqual(["s4"]);
    expect(m6.groups.map((g) => [g.label, g.count])).toEqual([["3-GURUH", 1], ["4-GURUH", 0]]);
  });

  it("a group, with or without a course", () => {
    expect(buildGradeFilter(QUEUE, [], GROUPS, { courseId: null, groupId: "g5b" }).visible.map((x) => x.submission_id)).toEqual(["s2", "s3"]);
    expect(buildGradeFilter(QUEUE, [], GROUPS, { courseId: "c5", groupId: "g6" }).visible.map((x) => x.submission_id)).toEqual(["s5"]);
  });

  it("a stale filter (a course or group that is not there) is ignored: everything shows", () => {
    const m = buildGradeFilter(QUEUE, [], GROUPS, { courseId: "nope", groupId: "nope" });
    expect(m.filter).toEqual(NO_FILTER);
    expect(m.visible).toHaveLength(5);
  });

  it("a course emptied this session keeps its chip at 0 (from the handled items) and stays selected", () => {
    const handled = [r("s4", G6, C6)];
    const m = buildGradeFilter(QUEUE.filter((x) => x.submission_id !== "s4"), handled, GROUPS, { courseId: "c6", groupId: null });
    expect(m.filter.courseId).toBe("c6");
    expect(m.visible).toEqual([]);
    expect(m.courses.map((c) => [c.short, c.count])).toEqual([["5.0", 4], ["CH6", 0]]);
  });

  it("one course, one group: no bar at all; one course, two groups: the group row only", () => {
    const one = buildGradeFilter([r("s1", G5A, C5)], [], [G5A], NO_FILTER);
    expect([one.showCourses, one.showGroups]).toEqual([false, false]);
    const two = buildGradeFilter([r("s1", G5A, C5), r("s2", G5B, C5)], [], [G5A, G5B], NO_FILTER);
    expect([two.showCourses, two.showGroups]).toEqual([false, true]);
    expect(two.groups.map((g) => g.label)).toEqual(["1-GURUH VIP", "2-GURUH VIP"]);
  });

  it("an active filter always shows its row, so 'Hammasi' is one tap away", () => {
    const m = buildGradeFilter([r("s1", G5A, C5)], [], [G5A], { courseId: "c5", groupId: null });
    expect(m.showCourses).toBe(true);
  });

  it("a row with no known course is only under 'Hammasi'", () => {
    const q = [r("s1", G5A, null), r("s2", G6, C6)];
    expect(buildGradeFilter(q, [], GROUPS, NO_FILTER).visible).toHaveLength(2);
    expect(buildGradeFilter(q, [], GROUPS, { courseId: "c6", groupId: null }).visible.map((x) => x.submission_id)).toEqual(["s2"]);
  });
});

describe("helpers", () => {
  it("matchesFilter", () => {
    expect(matchesFilter(QUEUE[4], { courseId: "c5", groupId: "g6" })).toBe(true);
    expect(matchesFilter(QUEUE[4], { courseId: "c6", groupId: null })).toBe(false);
  });

  it("countByCourse: per TASK course, unknown course left out, sorted", () => {
    expect(countByCourse([...QUEUE, r("s9", G5A, null)]).map((c) => [c.id, c.short, c.count])).toEqual([["c5", "5.0", 4], ["c6", "CH6", 1]]);
  });

  it("the URL carries the filter", () => {
    expect(filterFromSearch(new URLSearchParams("course=c5&group=g6"))).toEqual({ courseId: "c5", groupId: "g6" });
    expect(filterFromSearch(new URLSearchParams(""))).toEqual(NO_FILTER);
    expect(searchFromFilter({ courseId: "c5", groupId: null })).toEqual({ course: "c5" });
    expect(searchFromFilter(NO_FILTER)).toEqual({});
  });
});
