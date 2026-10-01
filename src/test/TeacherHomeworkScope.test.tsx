import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// /teacher/homework (teacher audit 2026-09-30):
//   F8    — students came from a direct `profiles` read, which RLS limits to the teacher's own row: the page was
//           empty for every teacher. They now come from staff_group_members.
//   F8/TUI-2 — a moved student's OTHER-course work must not be listed (or graded) under the new group.
//   TUI-8 — a slow response for the previously selected group must never land under the newly selected one.
type Q = { table: string; eq: Record<string, unknown>; inn: Record<string, unknown[]> };

const DB = {
  modules: [
    { id: "m5", title: "5.0 — 1-MODUL", position: 0, course_id: "c5" },
    { id: "m6", title: "6.0 — 1-MODUL", position: 0, course_id: "c6" },
  ],
  assignments: [
    { id: "a5", module_id: "m5", task_number: 1, sap_number: null, parent_id: null, max_score: 10, title: "PROMPT 5.0", is_active: true },
    { id: "a6", module_id: "m6", task_number: 1, sap_number: null, parent_id: null, max_score: 10, title: "PROMPT 6.0", is_active: true },
  ],
  submissions: [
    // Ali — a 5.0 student in 1-GURUH VIP 5.0.
    { id: "s1", user_id: "u1", assignment_id: "a5", submitted_text: "ali 5.0", submitted_image_url: null, submitted_at: "2026-09-29T10:00:00Z", score: null, score_feedback: null, is_late: false, scored_at: null },
    // Bobur — moved to the Challenge group: one Challenge task, and one OLD 5.0 task still ungraded.
    { id: "s2", user_id: "u2", assignment_id: "a6", submitted_text: "bobur 6.0", submitted_image_url: null, submitted_at: "2026-09-30T10:00:00Z", score: null, score_feedback: null, is_late: false, scored_at: null },
    { id: "s3", user_id: "u2", assignment_id: "a5", submitted_text: "bobur old 5.0", submitted_image_url: null, submitted_at: "2026-09-20T10:00:00Z", score: null, score_feedback: null, is_late: false, scored_at: null },
  ],
};

const h = vi.hoisted(() => ({
  groups: [] as { group_id: string; group_name: string; course_name: string }[],
  members: {} as Record<string, () => Promise<{ data: unknown; error: unknown }>>,
  reads: [] as string[],
  beacon: vi.fn(),
  auth: { user: { id: "t1" }, role: "teacher" },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/homework/VoiceRecorder", () => ({ VoiceRecorder: () => null }));
vi.mock("@/components/teacher/GradePhoto", () => ({ GradePhoto: () => null }));
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: vi.fn(), removeFeedbackVoice: vi.fn() }));
vi.mock("@/lib/teacherApi", () => ({ notifyGradeVoice: vi.fn() }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Radix Select needs pointer APIs jsdom lacks; a native <select> keeps the same value/onValueChange contract.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <select aria-label="Guruh" value={value} onChange={(e) => onValueChange(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));
vi.mock("@/integrations/supabase/client", () => {
  const resolveFrom = (q: Q) => {
    if (q.table === "modules") {
      return { data: DB.modules.filter((m) => !q.eq.course_id || m.course_id === q.eq.course_id), error: null };
    }
    if (q.table === "homework_assignments") {
      if (q.inn.module_id) return { data: DB.assignments.filter((a) => q.inn.module_id.includes(a.module_id)), error: null };
      return { data: DB.assignments.filter((a) => (q.inn.id || []).includes(a.id)), error: null };
    }
    if (q.table === "homework_submissions") {
      return { data: DB.submissions.filter((s) => (q.inn.user_id || []).includes(s.user_id)), error: null };
    }
    return { data: [], error: null };
  };
  return {
    supabase: {
      rpc: (fn: string, args?: { _group_id?: string }) => {
        if (fn === "teacher_groups") return Promise.resolve({ data: h.groups, error: null });
        if (fn === "staff_group_overview") {
          return Promise.resolve({ data: [{ course_id: args?._group_id === "g5" ? "c5" : "c6" }], error: null });
        }
        if (fn === "staff_group_members") return h.members[args!._group_id!]();
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        h.reads.push(table);
        const q: Q = { table, eq: {}, inn: {} };
        const api: Record<string, unknown> = {
          select: () => api, order: () => api, range: () => api,
          eq: (k: string, v: unknown) => { q.eq[k] = v; return api; },
          in: (k: string, v: unknown[]) => { q.inn[k] = v; return api; },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resolveFrom(q)).then(res, rej),
        };
        return api;
      },
    },
  };
});

import TeacherHomework from "@/pages/TeacherHomework";

const G5 = { group_id: "g5", group_name: "1-GURUH VIP 5.0", course_name: "AI CREATORS 5.0" };
const G6 = { group_id: "g6", group_name: "AC CHALLENGE | 1-GURUH", course_name: "AI CREATORS CHALLENGE 6.0" };
const ok = (data: unknown) => () => Promise.resolve({ data, error: null });
const ALI = [{ id: "u1", name: "Ali", last_name: "Valiyev", telegram_username: null }];
const BOBUR = [{ id: "u2", name: "Bobur", last_name: "Karimov", telegram_username: null }];

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const openPending = () => fireEvent.mouseDown(screen.getByRole("tab", { name: /^Kutilmoqda/ }));

beforeEach(() => {
  h.groups = [G5, G6];
  h.members = { g5: ok(ALI), g6: ok(BOBUR) };
  h.reads = [];
  h.beacon.mockReset();
});
afterEach(() => cleanup());

describe("TeacherHomework — a teacher sees her group's students (F8)", () => {
  it("loads students through staff_group_members (never a profiles read) and lists their work", async () => {
    render(<TeacherHomework />);
    await flush();
    expect(screen.getByRole("tab", { name: "👥 Talabalar (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Kutilmoqda (1)" })).toBeInTheDocument();
    openPending();
    expect(screen.getByText("Ali Valiyev")).toBeInTheDocument();
    expect(h.reads).not.toContain("profiles");
  });

  it("every group option names its course", async () => {
    render(<TeacherHomework />);
    await flush();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "1-GURUH VIP 5.0 · AI CREATORS 5.0",
      "AC CHALLENGE | 1-GURUH · AI CREATORS CHALLENGE 6.0",
    ]);
  });

  it("a failed student load is an error with a retry, never an empty 'no students' page", async () => {
    h.members.g5 = () => Promise.resolve({ data: null, error: { code: "42501", message: "forbidden" } });
    render(<TeacherHomework />);
    await flush();
    expect(screen.getByText("Ma'lumotlarni yuklab bo'lmadi.")).toBeInTheDocument();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "teacher_homework_load_failed" }));
    h.members.g5 = ok(ALI);
    fireEvent.click(screen.getByRole("button", { name: "Qayta urinish" }));
    await flush();
    expect(screen.getByRole("tab", { name: "👥 Talabalar (1)" })).toBeInTheDocument();
  });
});

describe("TeacherHomework — only the selected group's course (F8 / TUI-2)", () => {
  it("a moved student's old-course task is left out, and the page says how many", async () => {
    h.groups = [G6, G5];
    render(<TeacherHomework />);
    await flush();
    expect(screen.getByRole("tab", { name: "Kutilmoqda (1)" })).toBeInTheDocument();
    openPending();
    expect(screen.getByText("V1 — PROMPT 6.0")).toBeInTheDocument();
    expect(screen.queryByText("V1 — PROMPT 5.0")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Boshqa kursdagi 1 ta topshiriq bu ro'yxatga kiritilmadi");
  });
});

describe("TeacherHomework — a quick group switch never shows the previous group's data (TUI-8)", () => {
  it("the old group's late response is dropped", async () => {
    let releaseG5: () => void = () => {};
    h.members.g5 = () => new Promise((res) => { releaseG5 = () => res({ data: ALI, error: null }); });
    render(<TeacherHomework />);
    await flush();
    expect(screen.getByText("Yuklanmoqda…")).toBeInTheDocument();

    // Switch to the Challenge group while 5.0's student list is still loading.
    fireEvent.change(screen.getByRole("combobox", { name: "Guruh" }), { target: { value: "g6" } });
    await flush();
    expect(screen.getByRole("tab", { name: "👥 Talabalar (1)" })).toBeInTheDocument();

    // 5.0's response finally arrives — it must not replace the Challenge group's lists.
    await act(async () => { releaseG5(); });
    await flush();
    openPending();
    expect(screen.getByText("Bobur Karimov")).toBeInTheDocument();
    expect(screen.queryByText("Ali Valiyev")).not.toBeInTheDocument();
  });

  it("switching clears the previous group's lists at once (loading, not stale rows)", async () => {
    let releaseG6: () => void = () => {};
    h.members.g6 = () => new Promise((res) => { releaseG6 = () => res({ data: BOBUR, error: null }); });
    render(<TeacherHomework />);
    await flush();
    openPending();
    expect(screen.getByText("Ali Valiyev")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Guruh" }), { target: { value: "g6" } });
    await flush();
    expect(screen.queryByText("Ali Valiyev")).not.toBeInTheDocument();
    expect(screen.getByText("Yuklanmoqda…")).toBeInTheDocument();

    await act(async () => { releaseG6(); });
    await flush();
    expect(screen.getByText("Bobur Karimov")).toBeInTheDocument();
  });
});
