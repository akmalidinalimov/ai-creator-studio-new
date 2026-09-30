import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { approveErrorMessage, approveSummary, parseApproveResult, weekFromSearch } from "@/lib/weekApproval";

// Daily Tasks PR-9, the web side of the weekly approval: the bot's «👀 Ko‘rib chiqish» link (?week=) opens the week
// list on that week, and each week has «✅ Haftani tasdiqlash» -> confirm -> challenge_tasks_approve_week (the same RPC
// as the bot's button), whose refused drafts are listed with the guard's reason. The SQL side is tested on PGlite
// (supabase/functions/_challenge/testing/daily-tasks-week-approval-check.ts).

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
  status, source: "import", plan_ref: `P${id}`, plan_format: null, approved_at: status === "approved" ? "2026-09-30T10:00:00Z" : null,
  updated_at: "2026-09-30T10:00:00Z",
});

function world(tasks: unknown[]) {
  h.tables = {
    platform_settings: [
      { key: "challenge", value: { enabled: true, course_ids: [C6], group_ids: [], window: { start: "2026-10-01T00:00:00+05:00", end: null } } },
      { key: "challenge_tasks", value: { enabled: true, ai: false, task_weekdays: [1, 2, 3, 4, 5], points: { general: 5, instagram: 8 }, test_group_ids: [] } },
    ],
    courses: [{ id: C6, title: "AI CREATORS CHALLENGE 6.0" }],
    groups: [{ id: "g1", course_id: C6, name: "AC CHALLENGE | 1-GURUH", daily_task_chat_id: -1004440955972, daily_task_topic_id: 144 }],
    challenge_tasks: tasks,
    challenge_task_posts: [],
  };
}

beforeEach(() => {
  h.rpc.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T08:00:00Z")); // Thursday 13:00 Tashkent
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

describe("weekApproval lib", () => {
  it("?week= -> that week's Monday; junk -> null", () => {
    expect(weekFromSearch("?week=2026-10-07")).toBe("2026-10-05");
    expect(weekFromSearch("?week=2026-10-05")).toBe("2026-10-05");
    expect(weekFromSearch("?week=2026-10-11")).toBe("2026-10-05");
    expect(weekFromSearch("?week=2026-13-01")).toBeNull();
    expect(weekFromSearch("?x=1")).toBeNull();
    expect(weekFromSearch("")).toBeNull();
  });
  it("the RPC's answer, defensively", () => {
    expect(parseApproveResult({ ok: true, approved: 4, already_approved: 1, drafts_left: 1, failed: [{ date: "2026-10-06", error: "x" }, 5] }))
      .toEqual({ approved: 4, alreadyApproved: 1, draftsLeft: 1, failed: [{ date: "2026-10-06", error: "x" }] });
    expect(parseApproveResult({ ok: false })).toBeNull();
    expect(parseApproveResult(null)).toBeNull();
    expect(approveSummary({ approved: 0, alreadyApproved: 5, draftsLeft: 0, failed: [] })).toBe("Bu hafta allaqachon tasdiqlangan (5 ta vazifa)");
    expect(approveSummary({ approved: 5, alreadyApproved: 0, draftsLeft: 0, failed: [] })).toBe("5 ta vazifa tasdiqlandi");
    expect(approveErrorMessage("Faqat admin haftani tasdiqlay oladi")).toBe("Ruxsat yo‘q (faqat admin)");
  });
});

describe("AdminChallengeTasks: the weekly approval", () => {
  it("?week= from the bot opens the week list on that week, highlighted", async () => {
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-07");
    world([task(1, "2026-10-05", "draft", "Dushanba vazifasi"), task(2, "2026-10-12", "draft", "Keyingi hafta")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Dushanba vazifasi")).toBeInTheDocument();
    const wk = document.getElementById("week-2026-10-05");
    expect(wk).not.toBeNull();
    expect(wk?.getAttribute("data-focused")).toBe("true");
    expect(document.getElementById("week-2026-10-12")?.getAttribute("data-focused")).toBeNull();
    expect(screen.getByText("Botdagi havola")).toBeInTheDocument();
  });

  it("a deep-linked week with no task still shows (empty)", async () => {
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-19");
    world([task(1, "2026-10-05", "approved", "Birinchi")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Birinchi")).toBeInTheDocument();
    expect(document.getElementById("week-2026-10-19")?.getAttribute("data-focused")).toBe("true");
    expect(screen.getByText("Bu haftada vazifa yo‘q.")).toBeInTheDocument();
  });

  it("✅ Haftani tasdiqlash -> confirm -> the RPC for that week and course; refused drafts are listed", async () => {
    world([task(1, "2026-10-05", "draft", "Birinchi"), task(2, "2026-10-06", "draft", "Ikkinchi"), task(3, "2026-10-07", "approved", "Uchinchi")]);
    h.rpc.mockImplementation(async (name: string) => {
      if (name === "challenge_tasks_approve_week") {
        return { data: { ok: true, approved: 1, already_approved: 1, drafts_left: 1,
          failed: [{ task_id: 2, date: "2026-10-06", title: "Ikkinchi", error: "E’lon matni juda uzun: 4100 / 4000 belgi — matnni qisqartiring" }] }, error: null };
      }
      return { data: null, error: null };
    });
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-05");
    render(<AdminChallengeTasks />);
    const btn = await screen.findByText("✅ Haftani tasdiqlash (2)");
    fireEvent.click(btn);
    expect(await screen.findByText("2 ta qoralama tasdiqlansinmi?")).toBeInTheDocument();
    expect(h.rpc).not.toHaveBeenCalledWith("challenge_tasks_approve_week", expect.anything());
    fireEvent.click(screen.getByText("Ha, tasdiqlash"));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("challenge_tasks_approve_week", { _week_start: "2026-10-05", _course_id: C6 }));
    expect(await screen.findByText("Tasdiqlanmadi (1):")).toBeInTheDocument();
    expect(screen.getByText(/E’lon matni juda uzun/)).toBeInTheDocument();
  });

  it("a week with no draft has no approve button", async () => {
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-05");
    world([task(1, "2026-10-05", "approved", "Birinchi")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Birinchi")).toBeInTheDocument();
    expect(screen.queryByText(/Haftani tasdiqlash/)).toBeNull();
  });
});
