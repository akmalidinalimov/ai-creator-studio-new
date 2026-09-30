import { describe, it, expect, vi, beforeEach } from "vitest";

// fetchPendingQueue returns every queue row with the TASK's course (course_id + course_title), so the Mini App card
// can label "5.0 · 1-GURUH PRE" vs "CH6 · 3-GURUH" and the Baholash filter can split the courses. Since
// 20260930182000 the RPC returns both columns; an older RPC (the minutes between a frontend deploy and the
// migration) does not, and then ONE extra read attaches them. A failed course read must never fail the queue, and
// must not be silent.
const h = vi.hoisted(() => ({
  rpcRows: [] as unknown[],
  rpcArgs: [] as unknown[],
  assignRes: { data: [] as unknown[], error: null as null | { message: string } },
  selects: [] as string[],
  inIds: [] as string[],
  beacon: vi.fn(),
}));

vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      h.rpcArgs = args;
      return Promise.resolve({ data: h.rpcRows, error: null });
    },
    from: () => ({
      select: (cols: string) => {
        h.selects.push(cols);
        return {
          in: (_c: string, ids: string[]) => {
            h.inIds = ids;
            return Promise.resolve(h.assignRes);
          },
        };
      },
    }),
  },
}));

import { courseIdOfAssignmentRow, courseTitleOfAssignmentRow, fetchPendingQueue } from "@/lib/teacherApi";

const row = (id: string, assignment: string, group: string, extra: Record<string, unknown> = {}) => ({
  submission_id: id, user_id: "u", student_name: "Aziza", group_id: "g", group_name: group,
  module_number: 1, task_number: 1, assignment_id: assignment, assignment_title: "1- MODUL: PROMPT ENGINEERING",
  max_score: 10, submitted_at: "2026-09-30T10:00:00Z", previous_score: null, is_resubmission: false, media: null,
  submitted_image_url: null, ...extra,
});

beforeEach(() => {
  h.rpcRows = [row("s1", "a5", "1-GURUH VIP 5.0"), row("s2", "a6", "AC CHALLENGE | 1-GURUH"), row("s3", "a5", "1-GURUH VIP 5.0")];
  h.rpcArgs = [];
  h.assignRes = { data: [], error: null };
  h.selects = [];
  h.inIds = [];
  h.beacon.mockClear();
});

describe("fetchPendingQueue course of each row", () => {
  it("calls the RPC with no arguments (the page filters; the chips need every count)", async () => {
    await fetchPendingQueue();
    expect(h.rpcArgs).toEqual(["teacher_pending_submissions"]);
  });

  it("an RPC that returns course_id/course_title (20260930182000): no extra read, rows as they are", async () => {
    h.rpcRows = [
      row("s1", "a5", "1-GURUH VIP 5.0", { course_id: "c5", course_title: "AI CREATORS 5.0" }),
      row("s2", "a6", "AC CHALLENGE | 1-GURUH", { course_id: "c6", course_title: "AI CREATORS CHALLENGE 6.0" }),
    ];
    const q = await fetchPendingQueue();
    expect(h.selects).toEqual([]);
    expect(q.map((r) => [r.course_id, r.course_title])).toEqual([["c5", "AI CREATORS 5.0"], ["c6", "AI CREATORS CHALLENGE 6.0"]]);
  });

  it("an older RPC: attaches each task's course id and title from one deduped read", async () => {
    h.assignRes = {
      data: [
        { id: "a5", modules: { course_id: "c5", courses: { title: "AI CREATORS 5.0" } } },
        { id: "a6", modules: { course_id: "c6", courses: { title: "AI CREATORS CHALLENGE 6.0" } } },
      ],
      error: null,
    };
    const q = await fetchPendingQueue();
    expect(h.selects).toEqual(["id, modules(course_id, courses(title))"]);
    expect(h.inIds.sort()).toEqual(["a5", "a6"]);
    expect(q.map((r) => r.course_id)).toEqual(["c5", "c6", "c5"]);
    expect(q.map((r) => r.course_title)).toEqual(["AI CREATORS 5.0", "AI CREATORS CHALLENGE 6.0", "AI CREATORS 5.0"]);
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("a failed course read keeps the queue (course null) and beacons it", async () => {
    h.assignRes = { data: [], error: { message: "boom" } };
    const q = await fetchPendingQueue();
    expect(q).toHaveLength(3);
    expect(q.every((r) => r.course_title === null && r.course_id === null)).toBe(true);
    expect(h.beacon).toHaveBeenCalledTimes(1);
    expect(String(h.beacon.mock.calls[0][0].message)).toContain("hw_label_course_lookup_failed");
  });

  it("an empty queue makes no extra read", async () => {
    h.rpcRows = [];
    expect(await fetchPendingQueue()).toEqual([]);
    expect(h.inIds).toEqual([]);
    expect(h.selects).toEqual([]);
  });
});

describe("courseTitleOfAssignmentRow / courseIdOfAssignmentRow", () => {
  it("read object or array embeds, else null", () => {
    expect(courseTitleOfAssignmentRow({ modules: { courses: { title: "AI CREATORS 5.0" } } })).toBe("AI CREATORS 5.0");
    expect(courseTitleOfAssignmentRow({ modules: [{ courses: [{ title: "X" }] }] })).toBe("X");
    expect(courseTitleOfAssignmentRow({ modules: null })).toBeNull();
    expect(courseTitleOfAssignmentRow({ modules: { courses: { title: " " } } })).toBeNull();
    expect(courseTitleOfAssignmentRow(null)).toBeNull();
    expect(courseIdOfAssignmentRow({ modules: { course_id: "c5" } })).toBe("c5");
    expect(courseIdOfAssignmentRow({ modules: [{ course_id: "c6" }] })).toBe("c6");
    expect(courseIdOfAssignmentRow({ modules: { course_id: "" } })).toBeNull();
    expect(courseIdOfAssignmentRow({})).toBeNull();
  });
});
