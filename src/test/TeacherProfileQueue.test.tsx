import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// TeacherProfile's grading queue loads the oldest 100 pending rows + a head-only exact count of the
// same filter. These tests drive that read path with the REAL row shapes and assert the teacher is
// told when the queue is capped — and that a failed load is never presented as "nothing to grade".
type DbError = { code?: string; message: string } | null;
const h = vi.hoisted(() => ({
  subs: { data: [] as unknown[] | null, error: null as DbError },
  count: { count: 0 as number | null, error: null as DbError },
  // The head-only "pending submitted in the last 24h" count (the query that adds .gte on submitted_at).
  new24: { count: 0 as number | null, error: null as DbError },
  students: { data: [] as unknown[], error: null as DbError },
  beacon: vi.fn(),
  writes: [] as string[],
  // ONE stable object: TeacherProfile's effects depend on `user`, so a fresh object per render loops.
  auth: { user: { id: "t1" }, role: "teacher" },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/homework/VoiceRecorder", () => ({ VoiceRecorder: () => null }));
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: vi.fn(), removeFeedbackVoice: vi.fn() }));
vi.mock("@/lib/teacherApi", () => ({ notifyGradeVoice: vi.fn() }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => {
  const RPC: Record<string, unknown> = {
    teacher_profile_stats: [{ groups_count: 1, students_total: 1, graded_total: 0, avg_score_given: null }],
    teacher_groups: [{ group_id: "g1", group_name: "G1", course_name: null, total_students: 1, active_7d: 1, avg_completion_pct: 0, pending_homework: 0 }],
    teacher_weekly_self: null,
    teacher_xp: null,
    staff_group_members: [],
    teacher_group_top: [],
  };
  return {
    supabase: {
      rpc: (fn: string) => Promise.resolve(fn === "staff_list_students" ? h.students : { data: RPC[fn] ?? null, error: null }),
      from: (table: string) => {
        let head = false;
        let since = false;
        const b: Record<string, unknown> = {
          select: (_cols: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b; },
          update: () => { h.writes.push(table); return b; },
          or: () => b, order: () => b, limit: () => b, eq: () => b, maybeSingle: () => b,
          gte: () => { since = true; return b; },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(
            table === "profiles" ? { data: { name: "Ustoz", last_name: null, active_teacher_group_id: "g1" }, error: null }
              : head ? (since ? h.new24 : h.count) : h.subs,
          ).then(res, rej),
        };
        return b;
      },
    },
  };
});

import i18n from "@/i18n";
import TeacherProfile from "@/components/profile/TeacherProfile";

const row = (i: number) => ({
  id: `s${i}`, user_id: "u1", submitted_text: `answer ${i}`, submitted_image_url: null,
  submitted_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), score: null, score_is_stale: false,
  previous_attempts: [], media: [], telegram_message_url: null, score_feedback_voice_path: null,
  homework_assignments: { max_score: 10, title: "HW", description: "", modules: { position: 0, title: "M1" } },
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

async function openQueue() {
  render(<MemoryRouter><TeacherProfile /></MemoryRouter>);
  const tab = await screen.findByRole("tab", { name: /Queue/ });
  fireEvent.click(tab);
  return tab;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  h.subs = { data: [], error: null };
  h.count = { count: 0, error: null };
  h.new24 = { count: 0, error: null };
  h.students = { data: [{ id: "u1", name: "Ali", last_name: "Valiyev", group_id: "g1" }], error: null };
  h.beacon.mockReset();
  h.writes = [];
});
afterEach(() => cleanup());

describe("TeacherProfile grading queue — capped page indicator", () => {
  it("more pending than the page holds → says 'showing 100 of 150' and the tab shows the real total", async () => {
    h.subs = { data: rows(100), error: null };
    h.count = { count: 150, error: null };
    const tab = await openQueue();
    expect(await screen.findByText("Showing 100 of 150 waiting (oldest first). Grade these, then refresh the queue to load the other 50.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh queue" })).toBeInTheDocument();
    expect(tab.textContent).toContain("· 150");
    expect(screen.getAllByText(/^answer \d+$/)).toHaveLength(100);
    expect(h.beacon).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]); // display-only: loading the queue writes nothing
  });

  it("everything fits → no indicator, exact count on the tab", async () => {
    h.subs = { data: rows(40), error: null };
    h.count = { count: 40, error: null };
    const tab = await openQueue();
    expect(await screen.findByText("answer 0")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing \d+ of/)).not.toBeInTheDocument();
    expect(tab.textContent).toContain("· 40");
  });

  it("count request fails → degrades to the old view (no indicator) and beacons the failure", async () => {
    h.subs = { data: rows(100), error: null };
    h.count = { count: null, error: { code: "57014", message: "timeout" } };
    await openQueue();
    expect(await screen.findByText("answer 0")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing \d+ of/)).not.toBeInTheDocument();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "teacher_queue_count_failed" }));
  });

  it("queue load fails → error + retry, never the '🎉 no ungraded homework' state", async () => {
    h.subs = { data: null, error: { code: "PGRST000", message: "boom" } };
    await openQueue();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByText(/No ungraded homework/)).not.toBeInTheDocument();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "teacher_queue_load_failed" }));
  });

  it("queue overflows → the Home digest's 'new in 24h' comes from the server, not the capped page", async () => {
    // The page holds the OLDEST 100 (all from Sept 1 here), so counting it would say 0 new — exactly
    // when the backlog is largest. The server count of pending rows from the last 24h is shown instead.
    h.subs = { data: rows(100), error: null };
    h.count = { count: 150, error: null };
    h.new24 = { count: 7, error: null };
    render(<MemoryRouter><TeacherProfile /></MemoryRouter>);
    const label = await screen.findByText(/new submissions/);
    expect(label.querySelector("b")?.textContent).toBe("7");
  });

  it("no overflow → the Home digest still counts the loaded queue (updates live as the teacher grades)", async () => {
    h.subs = { data: rows(3), error: null };
    h.count = { count: 3, error: null };
    h.new24 = { count: 99, error: null }; // must be ignored when nothing is hidden
    render(<MemoryRouter><TeacherProfile /></MemoryRouter>);
    const label = await screen.findByText(/new submissions/);
    expect(label.querySelector("b")?.textContent).toBe("0");
  });

  it("genuinely empty → the 🎉 empty state, no beacon", async () => {
    await openQueue();
    expect(await screen.findByText(/No ungraded homework/)).toBeInTheDocument();
    expect(h.beacon).not.toHaveBeenCalled();
  });
});
