import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

// «Natijalar» — the admin results tab of /admin/challenge/tasks (Daily Tasks PR-7): the engine's
// admin_challenge_task_results for the selected task, and the audited override through admin_challenge_task_override.
const h = vi.hoisted(() => ({ rpc: vi.fn(), toast: { success: vi.fn(), error: vi.fn() }, beacon: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => h.rpc(...a) } }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));

import { ChallengeTaskResults } from "@/components/admin/ChallengeTaskResults";
import type { TaskRow } from "@/components/admin/challengeTasksShared";

const task = (id: number, date: string, title: string, status = "approved"): TaskRow => ({
  id, course_id: "c6", task_date: date, type: "general", title, body: "b", learn_line: null, submit_hint: null, accepts: ["photo"],
  requires: [], min_text_chars: null, min_duration_sec: null, minutes: null, points: null, check_rubric: null, requires_tag: null,
  status, source: "manual", plan_ref: null, plan_format: null, approved_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
});
const GROUPS = [{ id: "g1", name: "AC CHALLENGE | 1-GURUH", daily_task_chat_id: -1004440955972, daily_task_topic_id: 144 }];

beforeEach(() => {
  h.rpc.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
  h.rpc.mockImplementation(async (name: string, args: { _task_id?: number }) => {
    if (name === "admin_challenge_task_results") {
      return { data: { task: { id: args._task_id }, submissions: [
        { id: 11, user_id: "u1", name: "Ali", group_id: "g1", group: "AC CHALLENGE | 1-GURUH", status: "rejected", reason: "off_task",
          missing: [], hold_reason: null, points: 0, late_days: 0, submitted_at: "2026-10-05T05:00:00Z", attributed_via: "miniapp",
          source: "miniapp", moved_count: 0, items: 2 },
        { id: 12, user_id: "u2", name: "Vali", group_id: "g1", group: "AC CHALLENGE | 1-GURUH", status: "accepted", reason: null,
          missing: [], hold_reason: null, points: 5, late_days: 0, submitted_at: "2026-10-05T06:00:00Z", attributed_via: "today",
          source: "topic", moved_count: 0, items: 1 },
      ] }, error: null };
    }
    if (name === "admin_challenge_task_override") return { data: { ok: true, status: "ok" }, error: null };
    return { data: null, error: null };
  });
});
afterEach(() => cleanup());

describe("ChallengeTaskResults", () => {
  it("loads the latest task up to today and lists its submissions by group", async () => {
    render(<ChallengeTaskResults tasks={[task(1, "2026-10-05", "Birinchi"), task(2, "2026-10-06", "Ikkinchi"), task(3, "2026-10-04", "Bekor", "cancelled")]}
      groups={GROUPS} today="2026-10-05" />);
    expect(await screen.findByText("Ali")).toBeInTheDocument();
    expect(h.rpc).toHaveBeenCalledWith("admin_challenge_task_results", { _task_id: 1 });
    expect(screen.getByText("Vali")).toBeInTheDocument();
    expect(screen.getByText("AC CHALLENGE | 1-GURUH: 1/2 ✓")).toBeInTheDocument();
    expect(screen.getByText(/📱 ilova · 2 ta/)).toBeInTheDocument();
  });

  it("an override goes through the audited RPC and reloads", async () => {
    render(<ChallengeTaskResults tasks={[task(1, "2026-10-05", "Birinchi")]} groups={GROUPS} today="2026-10-05" />);
    const row = (await screen.findByText("Ali")).closest("tr")!;
    fireEvent.click(within(row).getByText("Qabul qilish"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Qabul qilish" }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("admin_challenge_task_override", { _sub: 11, _action: "accept", _args: {} }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.rpc.mock.calls.filter((c) => c[0] === "admin_challenge_task_results").length).toBeGreaterThanOrEqual(2);
  });

  it("an engine refusal is shown in Uzbek, not as success", async () => {
    h.rpc.mockImplementation(async (name: string) => name === "admin_challenge_task_override"
      ? { data: { ok: false, reason: "slot_taken" }, error: null }
      : { data: { submissions: [{ id: 11, user_id: "u1", name: "Ali", group: "G", status: "rejected", missing: [], items: 1 }] }, error: null });
    render(<ChallengeTaskResults tasks={[task(1, "2026-10-05", "Birinchi")]} groups={GROUPS} today="2026-10-05" />);
    const row = (await screen.findByText("Ali")).closest("tr")!;
    fireEvent.click(within(row).getByText("Qabul qilish"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Qabul qilish" }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Bu o‘quvchida shu vazifa uchun boshqa jonli topshiriq bor."));
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});
