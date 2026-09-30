import { describe, it, expect, vi, beforeEach } from "vitest";

// fetchPendingQueue attaches the TASK's course to every queue row (the RPC returns only the group), so the
// Mini App card can label "5.0 · 1-GURUH PRE" vs "CH6 · 3-GURUH". A failed course read must never fail the
// queue, and must not be silent.
const h = vi.hoisted(() => ({
  rpcRows: [] as unknown[],
  assignRes: { data: [] as unknown[], error: null as null | { message: string } },
  inIds: [] as string[],
  beacon: vi.fn(),
}));

vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: h.rpcRows, error: null }),
    from: () => ({
      select: () => ({
        in: (_c: string, ids: string[]) => {
          h.inIds = ids;
          return Promise.resolve(h.assignRes);
        },
      }),
    }),
  },
}));

import { courseTitleOfAssignmentRow, fetchPendingQueue } from "@/lib/teacherApi";

const row = (id: string, assignment: string, group: string) => ({
  submission_id: id, user_id: "u", student_name: "Aziza", group_id: "g", group_name: group,
  module_number: 1, task_number: 1, assignment_id: assignment, assignment_title: "1- MODUL: PROMPT ENGINEERING",
  max_score: 10, submitted_at: "2026-09-30T10:00:00Z", previous_score: null, is_resubmission: false, media: null,
  submitted_image_url: null,
});

beforeEach(() => {
  h.rpcRows = [row("s1", "a5", "1-GURUH VIP 5.0"), row("s2", "a6", "AC CHALLENGE | 1-GURUH"), row("s3", "a5", "1-GURUH VIP 5.0")];
  h.assignRes = { data: [], error: null };
  h.inIds = [];
  h.beacon.mockClear();
});

describe("fetchPendingQueue course labels", () => {
  it("attaches each task's course from one deduped read", async () => {
    h.assignRes = {
      data: [
        { id: "a5", modules: { courses: { title: "AI CREATORS 5.0" } } },
        { id: "a6", modules: { courses: { title: "AI CREATORS CHALLENGE 6.0" } } },
      ],
      error: null,
    };
    const q = await fetchPendingQueue();
    expect(h.inIds.sort()).toEqual(["a5", "a6"]);
    expect(q.map((r) => r.course_title)).toEqual(["AI CREATORS 5.0", "AI CREATORS CHALLENGE 6.0", "AI CREATORS 5.0"]);
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("a failed course read keeps the queue (course_title null) and beacons it", async () => {
    h.assignRes = { data: [], error: { message: "boom" } };
    const q = await fetchPendingQueue();
    expect(q).toHaveLength(3);
    expect(q.every((r) => r.course_title === null)).toBe(true);
    expect(h.beacon).toHaveBeenCalledTimes(1);
    expect(String(h.beacon.mock.calls[0][0].message)).toContain("hw_label_course_lookup_failed");
  });

  it("an empty queue makes no extra read", async () => {
    h.rpcRows = [];
    expect(await fetchPendingQueue()).toEqual([]);
    expect(h.inIds).toEqual([]);
  });
});

describe("courseTitleOfAssignmentRow", () => {
  it("reads object or array embeds, else null", () => {
    expect(courseTitleOfAssignmentRow({ modules: { courses: { title: "AI CREATORS 5.0" } } })).toBe("AI CREATORS 5.0");
    expect(courseTitleOfAssignmentRow({ modules: [{ courses: [{ title: "X" }] }] })).toBe("X");
    expect(courseTitleOfAssignmentRow({ modules: null })).toBeNull();
    expect(courseTitleOfAssignmentRow({ modules: { courses: { title: " " } } })).toBeNull();
    expect(courseTitleOfAssignmentRow(null)).toBeNull();
  });
});
