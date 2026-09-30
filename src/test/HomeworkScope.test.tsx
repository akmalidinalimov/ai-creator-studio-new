import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// Settings -> "Uy vazifalari". The section read groups.course_id from the client, but `groups` is admin-only
// under RLS, so a student ALWAYS fell back to every enrolled course — and a student with no enrollment got
// NO course filter at all: every published course's homework (27 paid students saw 5.0 + Challenge 6.0).
// The scope is now the group's course (group_rating_course_id, SECURITY DEFINER), else own enrollments,
// else nothing.
type DbError = { code?: string; message: string } | null;
const h = vi.hoisted(() => ({
  course: { data: "c6" as unknown, error: null as DbError },
  enrollments: { data: [] as unknown[], error: null as DbError },
  assignQueries: [] as Array<{ inCol: string; ids: unknown }>,
  tablesRead: [] as string[],
  beacon: vi.fn(),
  auth: { user: { id: "u1" } },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/components/homework/FeedbackVoicePlayer", () => ({ FeedbackVoicePlayer: () => null }));
vi.mock("@/integrations/supabase/client", () => {
  const ASSIGN = [
    { id: "a6", title: "6.0 vazifa", max_score: 10, task_number: 1, sap_number: null, parent_id: null, is_active: true, module_id: "m6",
      modules: { id: "m6", title: "1-modul", course_id: "c6", courses: { title: "CHALLENGE 6.0" } } },
  ];
  const client = {
    rpc: (fn: string) => Promise.resolve(fn === "group_rating_course_id" ? h.course : { data: null, error: null }),
    from: (table: string) => {
      h.tablesRead.push(table);
      let inArgs: { inCol: string; ids: unknown } | null = null;
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b, order: () => b,
        in: (col: string, ids: unknown) => { inArgs = { inCol: col, ids }; return b; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (table === "homework_assignments") h.assignQueries.push(inArgs ?? { inCol: "(none)", ids: null });
          const out = table === "enrollments" ? h.enrollments
            : table === "homework_assignments" ? { data: ASSIGN, error: null }
            : { data: [], error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  };
  return { supabase: client };
});

import { supabase } from "@/integrations/supabase/client";
import { resolveHomeworkCourseIds } from "@/lib/homeworkScope";
import { HomeworkProfileSection } from "@/components/HomeworkProfileSection";

beforeEach(() => {
  h.course = { data: "c6", error: null };
  h.enrollments = { data: [], error: null };
  h.assignQueries = [];
  h.tablesRead = [];
  h.beacon.mockReset();
});
afterEach(() => cleanup());

describe("resolveHomeworkCourseIds", () => {
  it("the group's course wins, even for a student still enrolled in their old course", async () => {
    h.enrollments = { data: [{ course_id: "c5" }, { course_id: "c6" }], error: null };
    expect(await resolveHomeworkCourseIds(supabase, "u1")).toEqual({ courseIds: ["c6"], source: "group" });
    expect(h.tablesRead).not.toContain("groups");   // never the RLS-blocked client read again
  });

  it("no group course: the student's own enrollments", async () => {
    h.course = { data: null, error: null };
    h.enrollments = { data: [{ course_id: "c5" }, { course_id: "c5" }], error: null };
    expect(await resolveHomeworkCourseIds(supabase, "u1")).toEqual({ courseIds: ["c5"], source: "enrollments" });
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("no group and no enrollment: NOTHING (it used to be every published course)", async () => {
    h.course = { data: null, error: null };
    expect(await resolveHomeworkCourseIds(supabase, "u1")).toEqual({ courseIds: [], source: "none" });
  });

  it("a failed lookup degrades to the enrollments, and is beaconed", async () => {
    h.course = { data: null, error: { code: "PGRST202", message: "not found" } };
    h.enrollments = { data: [{ course_id: "c5" }], error: null };
    expect(await resolveHomeworkCourseIds(supabase, "u1")).toEqual({ courseIds: ["c5"], source: "enrollments" });
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "homework_scope_unresolved", extra: { code: "PGRST202" } }));
  });
});

describe("HomeworkProfileSection", () => {
  it("filters the assignments by the group's course", async () => {
    render(<HomeworkProfileSection />);
    expect(await screen.findByText("1-modul")).toBeInTheDocument();
    expect(h.assignQueries).toEqual([{ inCol: "modules.course_id", ids: ["c6"] }]);
  });

  it("with no course at all, never queries the assignments unfiltered — it shows the empty state", async () => {
    h.course = { data: null, error: null };
    render(<HomeworkProfileSection />);
    expect(await screen.findByText("Hali topshiriqlar yo'q.")).toBeInTheDocument();
    await waitFor(() => expect(h.tablesRead).toContain("enrollments"));
    await new Promise((r) => setTimeout(r, 30)); // let any (buggy) follow-up query run before asserting it didn't
    expect(h.assignQueries).toEqual([]);
    expect(screen.queryByText(/Topshirildi/)).toBeNull();
  });
});
