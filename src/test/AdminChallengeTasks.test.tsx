import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import plan from "@/lib/__fixtures__/challenge6-daily-tasks-plan.json";

// A smoke test of the «Kunlik vazifalar» admin page against a mocked Supabase: the month grid, the tomorrow
// banner (task days only), the day drawer's SQL-rendered preview, and the importer calling the import RPC with
// the whole plan. The SQL side of every rule is tested on PGlite (supabase/functions/_challenge/testing/
// daily-tasks-calendar-check.ts).

const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";
type Res = { data: unknown; error: { message: string; code?: string } | null };

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const res: Res = { data: h.tables[table] ?? [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "in", "eq", "order", "limit"]) b[m] = () => b;
    b.then = (ok: (r: Res) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
    return b;
  };
  return { supabase: { from: (t: string) => builder(t), rpc: (...a: unknown[]) => h.rpc(...a) } };
});
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import AdminChallengeTasks from "@/pages/admin/AdminChallengeTasks";

const task = (id: number, date: string, status: string, title: string) => ({
  id, course_id: C6, task_date: date, type: "general", title, body: "Matn", learn_line: null, submit_hint: null,
  accepts: ["text", "photo", "document"], requires: [{ any: ["photo", "image_doc"], min: 1, label: "screenshot" }],
  min_text_chars: null, min_duration_sec: null, minutes: 10, points: null, check_rubric: null, requires_tag: null,
  status, source: "import", plan_ref: `P${id}`, plan_format: "screenshot (2)", approved_at: status === "approved" ? "2026-09-30T10:00:00Z" : null,
  updated_at: "2026-09-30T10:00:00Z",
});

function world(tasks: unknown[]) {
  h.tables = {
    platform_settings: [
      { key: "challenge", value: { enabled: true, course_ids: [C6], group_ids: [], window: { start: "2026-10-01T00:00:00+05:00", end: null } } },
      { key: "challenge_tasks", value: { enabled: false, ai: false, task_weekdays: [1, 2, 3, 4, 5], points: { general: 5, instagram: 8 }, test_group_ids: [] } },
    ],
    courses: [{ id: C6, title: "AI CREATORS CHALLENGE 6.0" }],
    groups: [
      { id: "g1", course_id: C6, name: "AC CHALLENGE | 1-GURUH", daily_task_chat_id: -1004440955972, daily_task_topic_id: 144 },
    ],
    challenge_tasks: tasks,
    challenge_task_posts: [],
  };
}

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (name: string) => {
    if (name === "admin_challenge_task_preview") {
      return { data: { text: "📅 <b>1-kun vazifasi</b> · 1-oktabr, payshanba\n<b>Birinchi</b>\n\nMatn", length: 60, max: 4000, day_no: 1,
        points: 5, late_points: 3, requires_problem: null }, error: null };
    }
    if (name === "admin_challenge_tasks_import") return { data: { created: 25, created_ids: [], skipped: [] }, error: null };
    return { data: null, error: null };
  });
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AdminChallengeTasks", () => {
  it("month grid + the red banner when TOMORROW is a task day without an approved task", async () => {
    vi.setSystemTime(new Date("2026-10-04T10:00:00Z")); // Sunday 15:00 Tashkent -> tomorrow Monday 10-05
    world([task(1, "2026-10-01", "approved", "Birinchi vazifa"), task(2, "2026-10-05", "draft", "Dushanba qoralamasi")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Birinchi vazifa")).toBeInTheDocument();
    expect(screen.getByText("Dushanba qoralamasi")).toBeInTheDocument();
    expect(screen.getByText("Ertangi vazifa yo‘q!")).toBeInTheDocument();
    expect(screen.getByText(/Tizim hali yoqilmagan/)).toBeInTheDocument();
  });

  it("no banner when tomorrow is a rest day (Friday -> Saturday)", async () => {
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    world([task(1, "2026-10-01", "approved", "Birinchi vazifa")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Birinchi vazifa")).toBeInTheDocument();
    expect(screen.queryByText("Ertangi vazifa yo‘q!")).toBeNull();
  });

  it("the day drawer shows the task and the SQL-rendered preview", async () => {
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    world([task(1, "2026-10-01", "approved", "Birinchi vazifa")]);
    render(<AdminChallengeTasks />);
    fireEvent.click(await screen.findByText("Birinchi vazifa"));
    expect(await screen.findByDisplayValue("Birinchi vazifa")).toBeInTheDocument();
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("admin_challenge_task_preview", expect.anything()), { timeout: 3000 });
    expect(await screen.findByText("1-kun vazifasi")).toBeInTheDocument();
    expect(screen.getByText(/minimal son avtomatik qo‘yilmadi/)).toBeInTheDocument(); // the "(2)" flag from plan_format
  });

  it("the importer sends the whole plan as drafts through the RPC", async () => {
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    world([]);
    render(<AdminChallengeTasks />);
    fireEvent.click(await screen.findByText("Rejani import qilish"));
    fireEvent.change(await screen.findByPlaceholderText('{"weeks":[{"week":1,"tasks":[...]}]}'), { target: { value: JSON.stringify(plan) } });
    const go = await screen.findByText("25 ta qoralama yaratish");
    fireEvent.click(go);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("admin_challenge_tasks_import", expect.anything()));
    const [, args] = h.rpc.mock.calls.find((c) => c[0] === "admin_challenge_tasks_import") as [string, { _course_id: string; _items: { task_date: string; plan_ref: string }[] }];
    expect(args._course_id).toBe(C6);
    expect(args._items).toHaveLength(25);
    expect(args._items[0]).toMatchObject({ task_date: "2026-10-01", plan_ref: "W1D1" });
  });
});
