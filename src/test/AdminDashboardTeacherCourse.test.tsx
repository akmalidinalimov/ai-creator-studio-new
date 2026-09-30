import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Audit TUI-4: every teacher lands on /admin/dashboard. The Kurs select was set once to the first published course
// by title ("AI CREATORS 5.0") and never followed ?group=, and the teacher-side activity RPCs return every group the
// teacher is primary on — so a Challenge group opened with 5.0's modules, and its stuck list named another cohort's
// students. The course now comes from the group (locked), and every activity row is limited to the open group.
type Q = { table: string; eq: Record<string, unknown>; inn: Record<string, unknown[]> };

const h = vi.hoisted(() => ({
  dashCourseArgs: [] as unknown[],
  auth: { user: { id: "t1" }, role: "teacher" },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/admin/WeeklyDigestTile", () => ({ WeeklyDigestTile: () => null }));
vi.mock("@/components/admin/AnalyticsTiles", () => ({ AnalyticsTiles: () => null }));
vi.mock("@/components/admin/TeacherLoginAnalytics", () => ({ TeacherLoginAnalytics: () => null }));
vi.mock("@/components/admin/InactiveStudentsList", () => ({ InactiveStudentsList: () => null }));
vi.mock("@/lib/mutate", () => ({ mutate: vi.fn(() => Promise.resolve({ status: "ok" })) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("recharts", () => {
  const C = () => null;
  return {
    ResponsiveContainer: C, AreaChart: C, Area: C, LineChart: C, Line: C, BarChart: C, Bar: C, PieChart: C, Pie: C,
    Cell: C, XAxis: C, YAxis: C, Tooltip: C, CartesianGrid: C, Legend: C,
  };
});
vi.mock("@/integrations/supabase/client", () => {
  const ago = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  const COURSES = [
    { id: "c5", title: "AI CREATORS 5.0", published: true },
    { id: "c6", title: "AI CREATORS CHALLENGE 6.0", published: true },
  ];
  const MODULES = [
    { id: "m5", title: "5.0 — 1-MODUL", position: 0, course_id: "c5", lessons: [{ id: "l5", published: true }] },
    { id: "m6", title: "6.0 — 1-MODUL", position: 0, course_id: "c6", lessons: [{ id: "l6a", published: true }, { id: "l6b", published: true }] },
  ];
  // u5: the teacher's 5.0 student. u6: the open Challenge group (g6). u7: ANOTHER Challenge group the teacher is primary on.
  const PROGRESS = [
    { user_id: "u5", lesson_id: "l5", updated_at: ago(10), completed_at: ago(10) },
    { user_id: "u6", lesson_id: "l6a", updated_at: ago(10), completed_at: ago(10) },
    { user_id: "u7", lesson_id: "l6a", updated_at: ago(10), completed_at: ago(10) },
  ];
  const STUDENTS = [
    { id: "u5", name: "Ali", last_name: "Valiyev", email: "", created_at: ago(40), last_sign_in_at: ago(10) },
    { id: "u6", name: "Bobur", last_name: "Karimov", email: "", created_at: ago(40), last_sign_in_at: ago(10) },
    { id: "u7", name: "Charos", last_name: "Aliyeva", email: "", created_at: ago(40), last_sign_in_at: ago(10) },
  ];
  const rpc = (fn: string, args?: Record<string, unknown>) => {
    switch (fn) {
      case "teacher_groups":
        return [
          { group_id: "g5", group_name: "1-GURUH VIP 5.0", course_name: "AI CREATORS 5.0", total_students: 1, pending_homework: 0 },
          { group_id: "g6", group_name: "AC CHALLENGE | 1-GURUH", course_name: "AI CREATORS CHALLENGE 6.0", total_students: 1, pending_homework: 0 },
          { group_id: "g7", group_name: "AC CHALLENGE | 2-GURUH", course_name: "AI CREATORS CHALLENGE 6.0", total_students: 1, pending_homework: 0 },
        ];
      case "staff_group_overview":
        return [{ course_id: args?._group_id === "g5" ? "c5" : "c6", course_name: args?._group_id === "g5" ? "AI CREATORS 5.0" : "AI CREATORS CHALLENGE 6.0" }];
      case "get_visible_student_ids":
        return [{ id: "u5" }, { id: "u6" }, { id: "u7" }];
      case "staff_group_members":
        return args?._group_id === "g6" ? [{ id: "u6" }] : args?._group_id === "g7" ? [{ id: "u7" }] : [{ id: "u5" }];
      case "staff_recent_auth_events":
        return [];
      case "staff_recent_lesson_progress":
        return PROGRESS.filter((p) => p.updated_at >= String(args?._since));
      case "staff_list_students":
        return STUDENTS;
      case "admin_dashboard_students":
        h.dashCourseArgs.push(args?._course_id);
        return [];
      default:
        return null;
    }
  };
  const resolveFrom = (q: Q) => {
    if (q.table === "courses") return { data: COURSES, error: null };
    if (q.table === "modules") return { data: MODULES.filter((m) => m.course_id === q.eq.course_id), error: null };
    if (q.table === "lessons") return { data: (q.inn.id || []).map((id) => ({ id, title: `Dars ${id}` })), error: null };
    return { data: [], error: null };
  };
  return {
    supabase: {
      rpc: (fn: string, args?: Record<string, unknown>) => Promise.resolve({ data: rpc(fn, args), error: null }),
      from: (table: string) => {
        const q: Q = { table, eq: {}, inn: {} };
        const api: Record<string, unknown> = {
          select: () => api, order: () => api, limit: () => api, gte: () => api, not: () => api, update: () => api,
          eq: (k: string, v: unknown) => { q.eq[k] = v; return api; },
          in: (k: string, v: unknown[]) => { q.inn[k] = v; return api; },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resolveFrom(q)).then(res, rej),
        };
        return api;
      },
    },
  };
});

import i18n from "@/i18n";
import AdminDashboard from "@/pages/admin/AdminDashboard";

const flush = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  h.dashCourseArgs = [];
});
afterEach(() => cleanup());

describe("AdminDashboard as the teacher dashboard (TUI-4)", () => {
  it("a Challenge group opens on the Challenge course, locked — never the first course by title", async () => {
    render(<MemoryRouter initialEntries={["/admin/dashboard?group=g6"]}><AdminDashboard /></MemoryRouter>);
    await flush();
    expect(screen.getByTestId("dashboard-course-locked")).toHaveTextContent("AI CREATORS CHALLENGE 6.0");
    expect(h.dashCourseArgs).toContain("c6");
    expect(h.dashCourseArgs).not.toContain("c5");
  });

  it("the stuck list names only the open group's students", async () => {
    render(<MemoryRouter initialEntries={["/admin/dashboard?group=g6"]}><AdminDashboard /></MemoryRouter>);
    await flush();
    expect(screen.getByText("Bobur Karimov")).toBeInTheDocument();
    // Charos is in the teacher's OTHER Challenge group; Ali is her 5.0 student. Neither belongs on g6's page.
    expect(screen.queryByText("Charos Aliyeva")).not.toBeInTheDocument();
    expect(screen.queryByText("Ali Valiyev")).not.toBeInTheDocument();
  });

  it("the 'My groups' cards name each group's course", async () => {
    render(<MemoryRouter initialEntries={["/admin/dashboard"]}><AdminDashboard /></MemoryRouter>);
    await flush();
    expect(screen.getByText("1-GURUH VIP 5.0")).toBeInTheDocument();
    expect(screen.getAllByText("AI CREATORS CHALLENGE 6.0")).toHaveLength(2);
    expect(screen.getAllByText("AI CREATORS 5.0")).toHaveLength(1);
  });
});
