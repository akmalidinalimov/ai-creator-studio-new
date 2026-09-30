import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { approveErrorMessage, approveSummary, parseApproveResult, weekDraftCounts, weekFromSearch } from "@/lib/weekApproval";

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
      .toEqual({ approved: 4, alreadyApproved: 1, draftsLeft: 1, failed: [{ date: "2026-10-06", error: "x" }], skippedPast: [], pastWeek: false });
    expect(parseApproveResult({ ok: true, approved: 0, skipped_past: [{ date: "2026-10-05", title: "T" }, null], past_week: true }))
      .toEqual({ approved: 0, alreadyApproved: 0, draftsLeft: 0, failed: [], skippedPast: [{ date: "2026-10-05", title: "T" }], pastWeek: true });
    expect(parseApproveResult({ ok: false })).toBeNull();
    expect(parseApproveResult(null)).toBeNull();
    const r = { approved: 0, alreadyApproved: 5, draftsLeft: 0, failed: [], skippedPast: [], pastWeek: false };
    expect(approveSummary(r)).toBe("Bu hafta allaqachon tasdiqlangan (5 ta vazifa)");
    expect(approveSummary({ ...r, approved: 5, alreadyApproved: 0 })).toBe("5 ta vazifa tasdiqlandi");
    expect(approveErrorMessage("Faqat admin haftani tasdiqlay oladi")).toBe("Ruxsat yo‘q (faqat admin)");
  });
  it("past days: never counted as approvable, and the answer says they were left alone", () => {
    const list = [
      { status: "draft", task_date: "2026-10-05" }, { status: "draft", task_date: "2026-10-06" },
      { status: "draft", task_date: "2026-10-07" }, { status: "approved", task_date: "2026-10-08" }, { status: "draft", task_date: "2026-10-09" },
    ];
    expect(weekDraftCounts(list, "2026-10-07")).toEqual({ open: 2, past: 2 }); // today (7th) counts as open
    expect(weekDraftCounts(list, "2026-10-12")).toEqual({ open: 0, past: 4 });
    const base = { approved: 0, alreadyApproved: 1, draftsLeft: 0, failed: [], pastWeek: false };
    const past = [{ date: "2026-10-05" }, { date: "2026-10-06" }];
    expect(approveSummary({ ...base, approved: 2, skippedPast: past })).toBe("2 ta vazifa tasdiqlandi, 2 ta o‘tgan kun tasdiqlanmadi");
    expect(approveSummary({ ...base, skippedPast: past })).toMatch(/^O‘tgan kunlar \(2 ta\) bu tugma bilan tasdiqlanmaydi/);
    expect(approveSummary({ ...base, skippedPast: past, pastWeek: true })).toMatch(/^Bu hafta o‘tib ketdi/);
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

  it("mid-week: the button counts today and later only; past drafts are left out and listed after the RPC", async () => {
    vi.setSystemTime(new Date("2026-10-07T05:00:00Z")); // Wednesday 7 October, 10:00 Tashkent
    world([task(1, "2026-10-05", "draft", "Dushanba"), task(2, "2026-10-06", "draft", "Seshanba"),
           task(3, "2026-10-07", "draft", "Chorshanba"), task(4, "2026-10-08", "draft", "Payshanba")]);
    h.rpc.mockImplementation(async (name: string) => {
      if (name === "challenge_tasks_approve_week") {
        return { data: { ok: true, approved: 2, already_approved: 0, drafts_left: 0, failed: [], past_week: false,
          skipped_past: [{ task_id: 1, date: "2026-10-05", title: "Dushanba", reason: "o‘tgan kun" },
                         { task_id: 2, date: "2026-10-06", title: "Seshanba", reason: "o‘tgan kun" }] }, error: null };
      }
      return { data: null, error: null };
    });
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-05");
    render(<AdminChallengeTasks />);
    fireEvent.click(await screen.findByText("✅ Haftani tasdiqlash (2)"));
    expect(await screen.findByText("2 ta qoralama tasdiqlansinmi?")).toBeInTheDocument();
    expect(screen.getByText(/O‘tgan kunlardagi 2 ta qoralama kiritilmaydi/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Ha, tasdiqlash"));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("challenge_tasks_approve_week", { _week_start: "2026-10-05", _course_id: C6 }));
    expect(await screen.findByText("⌛ O‘tgan kun — tasdiqlanmadi (2):")).toBeInTheDocument();
  });

  it("a week that is over: no approve button, only the past-days hint", async () => {
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z")); // Wednesday 14 October
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-05");
    world([task(1, "2026-10-05", "approved", "Birinchi"), task(2, "2026-10-06", "draft", "Unutilgan")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Unutilgan")).toBeInTheDocument();
    expect(screen.queryByText(/Haftani tasdiqlash/)).toBeNull();
    expect(screen.getByText(/⌛ O‘tgan kunlar \(1 ta qoralama\)/)).toBeInTheDocument();
  });

  it("a week with no draft has no approve button", async () => {
    window.history.pushState({}, "", "/admin/challenge/tasks?week=2026-10-05");
    world([task(1, "2026-10-05", "approved", "Birinchi")]);
    render(<AdminChallengeTasks />);
    expect(await screen.findByText("Birinchi")).toBeInTheDocument();
    expect(screen.queryByText(/Haftani tasdiqlash/)).toBeNull();
  });
});
