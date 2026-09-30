import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Spec G12 (Daily Tasks PR-7): while an admin previews as a student they hold that student's REAL session, so every
// daily-task write must be a silent, expected no-op — the Mini App submit (supabase.functions.invoke, which the
// impersonation guard does not patch), the one-tap corrections, the DM-permission stamp and the admin override.
// Reads stay allowed. Also pins the submit form's idempotency: a retry of the SAME form reuses its request_id.
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  beacon: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), info: vi.fn() },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => ({}),
    functions: { invoke: (...a: unknown[]) => h.invoke(...a) },
  },
}));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("sonner", () => ({ toast: h.toast }));

import "@/lib/impersonationGuard"; // patches the (mocked) shared client, exactly as main.tsx does
import { WRITE_RPCS } from "@/lib/impersonationGuard";
import { supabase } from "@/integrations/supabase/client";
import i18n from "@/i18n";
import { correctSubmission, prepareTask, recordWriteAccessGranted, submitDailyTask } from "@/lib/dailyTasks";
import DailyTaskSubmit from "@/components/challenge/DailyTaskSubmit";

const TASK = {
  id: 7, date: "2026-10-05", type: "general", title: "Birinchi", accepts: ["text", "photo"],
  requires: [{ any: ["text"], min: 1, label: "text" }],
};

beforeEach(async () => {
  await i18n.changeLanguage("uz");
  h.rpc.mockReset();
  h.invoke.mockReset();
  h.beacon.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
  h.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  window.localStorage.removeItem("impersonating");
});
afterEach(() => {
  cleanup();
  window.localStorage.removeItem("impersonating");
});

describe("impersonation (G12)", () => {
  it("WRITE_RPCS carries every daily-task write", () => {
    for (const n of ["my_challenge_task_move", "my_challenge_task_withdraw", "my_challenge_task_restore",
      "my_telegram_write_access_granted", "admin_challenge_task_override"]) {
      expect(WRITE_RPCS.has(n)).toBe(true);
    }
  });

  it("the guard (second layer) refuses those RPCs while previewing, and lets reads through", async () => {
    window.localStorage.setItem("impersonating", "Ali");
    const rpc = supabase.rpc as unknown as (n: string, a?: unknown) => Promise<unknown>;
    await expect(rpc("my_challenge_task_withdraw", { _sub: 1 })).rejects.toThrow(/read-only impersonation/);
    expect(h.rpc).not.toHaveBeenCalled();
    await rpc("my_challenge_tasks");
    expect(h.rpc).toHaveBeenCalledWith("my_challenge_tasks");
  });

  it("the lib writes are expected no-ops (first layer): nothing sent, nothing beaconed; prepare (a read) still runs", async () => {
    window.localStorage.setItem("impersonating", "Ali");
    expect(await submitDailyTask(new FormData())).toEqual({ ok: false, code: "impersonation_readonly" });
    expect(await correctSubmission("withdraw", 5)).toEqual({ ok: false, reason: "impersonation_readonly" });
    expect(await correctSubmission("move", 5, 6)).toEqual({ ok: false, reason: "impersonation_readonly" });
    expect(await recordWriteAccessGranted()).toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    h.invoke.mockResolvedValue({ data: { ok: false, reason: "miniapp_off" }, error: null });
    await prepareTask(7);
    expect(h.invoke).toHaveBeenCalledWith("submit-daily-task", { body: { mode: "prepare", task_id: 7 } });
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("the submit form is read-only while previewing and never calls the edge function", async () => {
    window.localStorage.setItem("impersonating", "Ali");
    render(<DailyTaskSubmit task={TASK} topicUrl={null} onDone={() => {}} />);
    expect(screen.getByText(i18n.t("dailyTasks.submit.readonly"))).toBeInTheDocument();
    const send = screen.getByRole("button", { name: i18n.t("dailyTasks.submit.send") });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.beacon).not.toHaveBeenCalled();
  });
});

describe("the submit form's request id", () => {
  it("a retry of the same form reuses it (Telegram busy); a definitive answer starts a new one", async () => {
    const onDone = vi.fn();
    const ids: string[] = [];
    h.invoke.mockImplementation(async (_fn: string, opts: { body: FormData }) => {
      ids.push(String(opts.body.get("request_id")));
      expect(opts.body.get("task_id")).toBe("7");
      if (ids.length === 1) {
        return { data: null, error: { context: new Response(JSON.stringify({ error: "telegram_post_failed", retry_after: 30 }), { status: 502 }) } };
      }
      return { data: { ok: true, result: { outcome: "created", submission: { status: "checking" } }, posted: 1, failed: 0 }, error: null };
    });
    render(<DailyTaskSubmit task={TASK} topicUrl="https://t.me/c/4440955972/144" onDone={onDone} />);
    fireEvent.change(screen.getByLabelText(i18n.t("dailyTasks.submit.textLabel")), { target: { value: "Mana bugungi vazifam, ko'ring!" } });
    const send = screen.getByRole("button", { name: i18n.t("dailyTasks.submit.send") });
    fireEvent.click(send);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(i18n.t("dailyTasks.submit.errors.rate_limited", { sec: 30 })));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("dailyTasks.submit.send") }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]); // the same form → the same claim (no double post, first claim time kept)
    expect(h.toast.success).toHaveBeenCalledWith(i18n.t("dailyTasks.submit.result.checking"));
    expect(h.beacon).not.toHaveBeenCalled(); // a busy Telegram is expected, not a client error
  });
});
