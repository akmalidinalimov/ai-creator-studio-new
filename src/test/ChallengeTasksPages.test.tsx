import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

// Kunlik vazifalar pages (Daily Tasks PR-7): HIDDEN while platform_settings.challenge_tasks.miniapp (or .enabled) is
// false — the Dashboard card renders nothing and the pages only say where the work goes (the group topic); once on,
// the list, the task post (rendered as text) and the submit form come from the engine's answers.
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

const TODAY = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
const TASKS = [
  { id: 7, date: TODAY, day_no: 3, type: "general", title: "Bugungi vazifa", open: true, closed: false, submission: null },
  { id: 6, date: "2026-10-01", day_no: 1, type: "instagram", title: "Instagram posti", open: false, closed: true,
    submission: { id: 40, status: "accepted", points: 8, late_days: 0, missing: [], reason: null, submitted_at: "2026-10-01T06:00:00Z" } },
];
const my = (enabled: boolean, miniapp: boolean) => ({
  data: { ok: true, enabled, miniapp, topic_url: "https://t.me/c/4440955972/144", streak: 2, points: 13, tasks: TASKS }, error: null,
});

beforeEach(async () => {
  await i18n.changeLanguage("uz");
  h.beacon.mockReset();
});
afterEach(() => cleanup());

describe("hidden while miniapp=false", () => {
  it("the Dashboard card renders nothing; the list page only points to the group topic", async () => {
    h.my = my(true, false);
    const { container } = render(<MemoryRouter><DailyTasksCard /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();

    render(<MemoryRouter><ChallengeTasks /></MemoryRouter>);
    expect(await screen.findByText(i18n.t("dailyTasks.topicOnlyTitle"))).toBeInTheDocument();
    expect(screen.queryByText("Bugungi vazifa")).toBeNull();
    expect(screen.getByRole("link", { name: /Qo'shimcha vazifalar» topikini ochish/ })).toHaveAttribute("href", "https://t.me/c/4440955972/144");
  });

  it("outside the challenge: nothing on the Dashboard, a plain note on the page", async () => {
    h.my = { data: { ok: false, reason: "not_in_challenge" }, error: null };
    const { container } = render(<MemoryRouter><DailyTasksCard /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    render(<MemoryRouter><ChallengeTasks /></MemoryRouter>);
    expect(await screen.findByText(i18n.t("dailyTasks.notInChallengeTitle"))).toBeInTheDocument();
    expect(h.beacon).not.toHaveBeenCalled();
  });
});

describe("live (enabled + miniapp)", () => {
  it("the Dashboard card shows today's task; the list shows every task with its status", async () => {
    h.my = my(true, true);
    render(<MemoryRouter><DailyTasksCard /></MemoryRouter>);
    expect(await screen.findByText("Bugungi vazifa")).toBeInTheDocument();
    cleanup();
    render(<MemoryRouter><ChallengeTasks /></MemoryRouter>);
    expect(await screen.findByText("Instagram posti")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dailyTasks.status.accepted"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dailyTasks.streak", { days: 2 }), { exact: false })).toBeInTheDocument();
  });

  it("a task page renders the post as text and offers the form when the engine says ok", async () => {
    h.my = my(true, true);
    h.prep = { data: {
      ok: true, reason: null, detail: null, submission: null, submission_id: null, open_tasks: [], topic_url: "https://t.me/c/4440955972/144",
      task: { id: 7, date: TODAY, type: "general", title: "Bugungi vazifa", accepts: ["text", "photo"], requires: [{ any: ["photo"], min: 1, label: "screenshot" }] },
      text: "📅 <b>3-kun vazifasi</b>\n<b>Bugungi vazifa</b>\n\nSkrinshot <img src=x> yuboring",
    }, error: null };
    render(
      <MemoryRouter initialEntries={["/challenge/tasks/7"]}>
        <Routes><Route path="/challenge/tasks/:taskId" element={<ChallengeTask />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("3-kun vazifasi")).toBeInTheDocument();
    expect(screen.getByText(/Skrinshot <img src=x> yuboring/)).toBeInTheDocument(); // literal text, never markup
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByRole("button", { name: i18n.t("dailyTasks.submit.send") })).toBeInTheDocument();
  });

  it("a closed task says why and links the topic, no form", async () => {
    h.my = my(true, true);
    h.prep = { data: { ok: false, reason: "closed", open_tasks: [], topic_url: "https://t.me/c/4440955972/144", task: null, text: null }, error: null };
    render(
      <MemoryRouter initialEntries={["/challenge/tasks/6"]}>
        <Routes><Route path="/challenge/tasks/:taskId" element={<ChallengeTask />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(i18n.t("dailyTasks.reasons.closed"))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: i18n.t("dailyTasks.submit.send") })).toBeNull());
    expect(screen.getByText(i18n.t("dailyTasks.status.accepted"))).toBeInTheDocument(); // the student's accepted work
  });
});
