import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

// Kunlik vazifalar — every state a student (or a non-student) can meet on the Dashboard card, the /challenge/tasks
// list and the task page, with ONE status rule (taskStatus) and ONE "who is this for" rule (scopeOf) behind all three:
//   5.0 student            card hidden; list AND task page say "this is for challenge-group students" (never
//                          "Vazifa topilmadi." + "contact an admin" about a challenge they are not in)
//   6.0 before 09:00       today's task is listed from 00:00 but not open: "Hali ochilmagan · 09:00 da", never
//                          "Topshirilmagan"
//   open / submitted / missed
//   staff / inactive       my_challenge_tasks' new reasons (fix/daily-tasks-pre-monday) hide the card; the pages say why
const h = vi.hoisted(() => ({
  my: { data: null as unknown, error: null as unknown },
  prep: { data: null as unknown, error: null as unknown },
  beacon: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string) => Promise.resolve(name === "my_challenge_tasks" ? h.my : { data: null, error: null }),
    from: () => {
      const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return b;
    },
    functions: { invoke: () => Promise.resolve(h.prep) },
  },
}));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" }, role: "student" }) }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import i18n from "@/i18n";
import ChallengeTasks from "@/pages/challenge/ChallengeTasks";
import ChallengeTask from "@/pages/challenge/ChallengeTask";
import { DailyTasksCard } from "@/components/challenge/DailyTasksCard";
import { scopeOf, statusTone, taskStatus, type MyTasksResult } from "@/lib/dailyTasks";

const TODAY = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
const TOPIC = "https://t.me/c/4440955972/144";
type Row = { id: number; date: string; day_no: number; type: string; title: string; open: boolean; closed: boolean; submission: unknown };
const today = (over: Partial<Row> = {}): Row =>
  ({ id: 7, date: TODAY, day_no: 3, type: "general", title: "Bugungi vazifa", open: true, closed: false, submission: null, ...over });
const missedRow: Row = { id: 5, date: "2026-10-05", day_no: 1, type: "general", title: "Birinchi vazifa", open: false, closed: true, submission: null };
const live = (tasks: Row[]) => ({
  data: { ok: true, enabled: true, miniapp: true, topic_url: TOPIC, streak: 2, points: 13, tasks }, error: null,
});
const refused = (reason: string) => ({ data: { ok: false, reason }, error: null });
const prepAnswer = (over: Record<string, unknown>) => ({
  data: { ok: false, reason: null, detail: null, task: null, submission: null, submission_id: null, open_tasks: [], topic_url: null, text: null, ...over },
  error: null,
});

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const notOpenChip = () => T("dailyTasks.status.not_open", { time: "09:00" });
const settle = () => new Promise((r) => setTimeout(r, 20));

const renderCard = () => render(<MemoryRouter><DailyTasksCard /></MemoryRouter>);
const renderList = () => render(<MemoryRouter><ChallengeTasks /></MemoryRouter>);
const renderTask = (id = 7) => render(
  <MemoryRouter initialEntries={[`/challenge/tasks/${id}`]}>
    <Routes><Route path="/challenge/tasks/:taskId" element={<ChallengeTask />} /></Routes>
  </MemoryRouter>,
);

beforeEach(async () => {
  await i18n.changeLanguage("uz");
  h.beacon.mockReset();
  h.prep = prepAnswer({});
});
afterEach(() => cleanup());

describe("the rules (pure)", () => {
  it("taskStatus: the submission wins; else missed / open / not_open — never 'none'", () => {
    expect(taskStatus({ open: false, closed: false, submission: null })).toBe("not_open");
    expect(taskStatus({ open: true, closed: false, submission: null })).toBe("open");
    expect(taskStatus({ open: false, closed: true, submission: null })).toBe("missed");
    expect(taskStatus({ open: true, closed: false, submission: { id: 1, status: "checking" } })).toBe("checking");
    expect(taskStatus({ open: false, closed: true, submission: { id: 1, status: "accepted" } })).toBe("accepted");
    expect(statusTone("open")).toBe("wait");
    expect(statusTone("not_open")).toBe("none");
    expect(statusTone("missed")).toBe("none");
  });

  it("scopeOf: my_challenge_tasks' verdict first, then prepare's refusal of the ACCOUNT (never of the task)", () => {
    const ok = live([]).data as MyTasksResult;
    const p = (reason: string | null, detail: string | null = null, okFlag = false) =>
      ({ ...(prepAnswer({ reason, detail, ok: okFlag }).data as object) }) as never;
    expect(scopeOf(ok)).toBe("student");
    expect(scopeOf({ ok: false, reason: "not_in_challenge" })).toBe("outside");
    expect(scopeOf({ ok: false, reason: "staff" })).toBe("staff");
    expect(scopeOf({ ok: false, reason: "inactive" })).toBe("inactive");
    expect(scopeOf({ ok: false, reason: "error" })).toBeNull();
    expect(scopeOf({ ok: false, reason: "not_deployed" })).toBeNull();
    expect(scopeOf(null, p("held_sender", "sender_out_of_scope"))).toBe("outside");
    expect(scopeOf({ ok: false, reason: "error" }, p("held_sender", "no_group"))).toBe("outside");
    expect(scopeOf(ok, p("held_sender", "inactive"))).toBe("inactive");
    expect(scopeOf(ok, p("staff"))).toBe("staff"); // the live engine today: my_challenge_tasks ok, prepare refuses staff
    expect(scopeOf(ok, p("not_open"))).toBe("student"); // a refusal of the TASK keeps the page
    expect(scopeOf(ok, p("closed"))).toBe("student");
    expect(scopeOf(ok, { error: "network" })).toBe("student");
    expect(scopeOf(ok, p("held_sender"))).toBe("student"); // no detail: the page keeps the held_sender note
  });
});

describe("5.0 student (not in the challenge)", () => {
  beforeEach(() => {
    h.my = refused("not_in_challenge");
    h.prep = prepAnswer({ reason: "held_sender", detail: "sender_out_of_scope" });
  });

  it("the card renders nothing; the list says it is for challenge-group students", async () => {
    const { container } = renderCard();
    await settle();
    expect(container).toBeEmptyDOMElement();
    renderList();
    expect(await screen.findByText(T("dailyTasks.notInChallengeTitle"))).toBeInTheDocument();
    expect(screen.getByText(T("dailyTasks.notInChallengeBody"))).toBeInTheDocument();
  });

  it("the task page shows the SAME empty state — no 'Vazifa topilmadi.', no 'contact an admin'", async () => {
    renderTask();
    expect(await screen.findByText(T("dailyTasks.notInChallengeTitle"))).toBeInTheDocument();
    expect(screen.getByText(T("dailyTasks.notInChallengeBody"))).toBeInTheDocument();
    expect(screen.queryByText(T("dailyTasks.task.notFound"))).toBeNull();
    expect(screen.queryByText(T("dailyTasks.reasons.held_sender"))).toBeNull();
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("no group at all (held_sender/no_group) and daily tasks paused (prepare 'disabled') read the same", async () => {
    h.prep = prepAnswer({ reason: "held_sender", detail: "no_group" });
    renderTask();
    expect(await screen.findByText(T("dailyTasks.notInChallengeTitle"))).toBeInTheDocument();
    cleanup();
    h.prep = prepAnswer({ reason: "disabled" });
    renderTask();
    expect(await screen.findByText(T("dailyTasks.notInChallengeTitle"))).toBeInTheDocument();
    expect(screen.queryByText(T("dailyTasks.reasons.disabled"))).toBeNull();
  });
});

describe("6.0 student, before 09:00 (today's task listed, not open yet)", () => {
  beforeEach(() => { h.my = live([today({ open: false, closed: false })]); });

  it("the card says 'Hali ochilmagan · 09:00 da', never 'Topshirilmagan'", async () => {
    renderCard();
    expect(await screen.findByText("Bugungi vazifa")).toBeInTheDocument();
    expect(screen.getByText(notOpenChip())).toBeInTheDocument();
    expect(notOpenChip()).toBe("Hali ochilmagan · 09:00 da");
    expect(screen.queryByText(T("dailyTasks.status.none"))).toBeNull();
  });

  it("the list shows the same chip", async () => {
    renderList();
    expect(await screen.findByText("Bugungi vazifa")).toBeInTheDocument();
    expect(screen.getByText(notOpenChip())).toBeInTheDocument();
    expect(screen.queryByText(T("dailyTasks.status.none"))).toBeNull();
  });

  it("the task page says when it opens", async () => {
    h.prep = prepAnswer({ reason: "not_open", topic_url: TOPIC });
    renderTask();
    const note = await screen.findByText(T("dailyTasks.reasons.not_open", { time: "09:00" }));
    expect(note.textContent).toContain("09:00");
    expect(screen.getByRole("heading", { name: "Bugungi vazifa" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: T("dailyTasks.submit.send") })).toBeNull();
  });
});

describe("6.0 student, later states", () => {
  it("open: 'Ochiq' on the card and the list (one rule, the two never disagree)", async () => {
    h.my = live([today({ open: true })]);
    renderCard();
    expect(await screen.findByText(T("dailyTasks.status.open"))).toBeInTheDocument();
    cleanup();
    renderList();
    expect(await screen.findByText(T("dailyTasks.status.open"))).toBeInTheDocument();
  });

  it("submitted: the submission's status on the card and the list", async () => {
    const sub = { id: 41, status: "checking", points: null, late_days: 0, missing: [], reason: null, submitted_at: new Date().toISOString() };
    h.my = live([today({ open: true, submission: sub })]);
    renderCard();
    expect(await screen.findByText(T("dailyTasks.status.checking"))).toBeInTheDocument();
    cleanup();
    renderList();
    expect(await screen.findByText(T("dailyTasks.status.checking"))).toBeInTheDocument();
  });

  it("missed: a closed task with no work says 'O'tkazib yuborildi'", async () => {
    h.my = live([today({ open: true }), missedRow]);
    renderList();
    expect(await screen.findByText("Birinchi vazifa")).toBeInTheDocument();
    expect(screen.getByText(T("dailyTasks.status.missed"))).toBeInTheDocument();
  });

  it("the card labels its numbers as the TASK streak and TASK points (not the activity streak chip / XP)", async () => {
    h.my = live([today({ open: true })]);
    renderCard();
    expect(await screen.findByText("Bugungi vazifa")).toBeInTheDocument();
    expect(screen.getByText(`${T("dailyTasks.dashboard.taskStreak", { days: 2 })} · ${T("dailyTasks.dashboard.taskPoints", { points: 13 })}`))
      .toBeInTheDocument();
    expect(T("dailyTasks.dashboard.taskStreak", { days: 2 })).toBe("Vazifa seriyasi: 2 kun");
    expect(T("dailyTasks.dashboard.taskPoints", { points: 13 })).toBe("Vazifa bali: 13");
  });
});

describe("staff / inactive (my_challenge_tasks' new reasons)", () => {
  it("staff: the card renders nothing; the list and the task page say it is for students", async () => {
    h.my = refused("staff");
    h.prep = prepAnswer({ reason: "staff" });
    const { container } = renderCard();
    await settle();
    expect(container).toBeEmptyDOMElement();
    renderList();
    expect(await screen.findByText(T("dailyTasks.reasons.staff"))).toBeInTheDocument();
    cleanup();
    renderTask();
    expect(await screen.findByText(T("dailyTasks.reasons.staff"))).toBeInTheDocument();
    expect(screen.queryByText(T("dailyTasks.task.notFound"))).toBeNull();
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("staff on today's engine (my_challenge_tasks still ok, prepare refuses): the task page says it is for students", async () => {
    h.my = live([today({ open: true })]);
    h.prep = prepAnswer({ reason: "staff" });
    renderTask();
    expect(await screen.findByText(T("dailyTasks.reasons.staff"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bugungi vazifa" })).toBeNull();
  });

  it("inactive: the card renders nothing; the pages say the profile is not active (not the held_sender note)", async () => {
    h.my = refused("inactive");
    h.prep = prepAnswer({ reason: "held_sender", detail: "inactive" });
    const { container } = renderCard();
    await settle();
    expect(container).toBeEmptyDOMElement();
    renderList();
    expect(await screen.findByText(T("dailyTasks.reasons.inactive"))).toBeInTheDocument();
    cleanup();
    renderTask();
    expect(await screen.findByText(T("dailyTasks.reasons.inactive"))).toBeInTheDocument();
    expect(screen.queryByText(T("dailyTasks.reasons.held_sender"))).toBeNull();
  });
});

describe("i18n", () => {
  it("every new key exists in uz, ru and en and interpolates", async () => {
    for (const lng of ["uz", "ru", "en"]) {
      await i18n.changeLanguage(lng);
      for (const k of ["dailyTasks.status.not_open", "dailyTasks.reasons.not_open"]) {
        const s = i18n.t(k, { time: "09:00" });
        expect(s, `${lng} ${k}`).toContain("09:00");
        expect(s).not.toContain("{{");
      }
      expect(i18n.exists("dailyTasks.reasons.inactive", { lng })).toBe(true);
      expect(i18n.t("dailyTasks.dashboard.taskStreak", { days: 4 })).toContain("4");
      expect(i18n.t("dailyTasks.dashboard.taskPoints", { points: 9 })).toContain("9");
    }
  });
});
