import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// Audit TUI-3: the Mini App broadcast used to DM the whole remembered group the moment "Yuborish" was tapped —
// no confirmation, no course on the options, and a success line that did not say which group got it. A broadcast
// cannot be recalled and blocks the correction for an hour, so the send now goes through a confirmation that
// names the group, the course and the exact recipient count, and sends only the snapshot that was confirmed.
type Member = { telegram_id: number | null };
const h = vi.hoisted(() => ({
  members: { data: [] as Member[] | null, error: null as { code?: string; message: string } | null },
  invoke: vi.fn(),
  beacon: vi.fn(),
  setGroupId: vi.fn(),
  groupId: "g6" as string | null,
}));

const GROUPS = [
  { id: "g5", name: "1-GURUH VIP 5.0", courseName: "AI CREATORS 5.0", totalStudents: 40, active7d: 0, avgCompletionPct: 0, pendingHomework: 0 },
  { id: "g6", name: "AC CHALLENGE | 2-GURUH", courseName: "AI CREATORS CHALLENGE 6.0", totalStudents: 3, active7d: 0, avgCompletionPct: 0, pendingHomework: 0 },
];

vi.mock("@/hooks/useSelectedGroup", () => ({
  useSelectedGroup: () => ({
    groups: GROUPS, groupId: h.groupId, setGroupId: h.setGroupId, loading: false, error: false, reload: vi.fn(),
  }),
}));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (fn: string) => Promise.resolve(fn === "staff_group_members" ? h.members : { data: null, error: null }),
    functions: { invoke: h.invoke },
  },
}));

import TeacherBroadcast from "@/pages/teacher/TeacherBroadcast";

const typeMessage = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Xabar" }), { target: { value: text } });
const clickSend = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Yuborish$/ })); }); };

beforeEach(() => {
  h.members = { data: [{ telegram_id: 11 }, { telegram_id: 12 }, { telegram_id: null }], error: null };
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ data: { ok: true, sent: 2, failed: 0, total: 2, skipped_no_telegram: 1 }, error: null });
  h.beacon.mockReset();
  h.setGroupId.mockReset();
  h.groupId = "g6";
});
afterEach(() => cleanup());

describe("TeacherBroadcast — confirm before sending (TUI-3)", () => {
  it("every group option names its course", () => {
    render(<TeacherBroadcast />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "1-GURUH VIP 5.0 · AI CREATORS 5.0",
      "AC CHALLENGE | 2-GURUH · AI CREATORS CHALLENGE 6.0",
    ]);
  });

  it("'Yuborish' only opens the confirmation (group, course, exact recipients); 'Ha, yuborish' sends the snapshot", async () => {
    render(<TeacherBroadcast />);
    typeMessage("  Ertaga 10:00 da dars  ");
    await clickSend();

    expect(h.invoke).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("AC CHALLENGE | 2-GURUH");
    expect(dialog).toHaveTextContent("AI CREATORS CHALLENGE 6.0");
    expect(dialog).toHaveTextContent("2 ta o'quvchi (Telegram orqali)");
    expect(dialog).toHaveTextContent("1 ta o'quvchi Telegram'ni ulamagan");
    // What was confirmed cannot change underneath: group and message are locked while the panel is open.
    expect(screen.getByRole("combobox", { name: "Guruh" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Xabar" })).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Ha, yuborish/ })); });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("teacher-broadcast-group", {
      body: { group_id: "g6", message: "Ertaga 10:00 da dars" },
    });
    expect(screen.getByText(/«AC CHALLENGE \| 2-GURUH» guruhidagi 2 ta o'quvchiga xabar yuborildi/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("'Bekor qilish' sends nothing and unlocks the form", async () => {
    render(<TeacherBroadcast />);
    typeMessage("Salom");
    await clickSend();
    fireEvent.click(screen.getByRole("button", { name: "Bekor qilish" }));
    expect(h.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Guruh" })).not.toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Xabar" })).toHaveValue("Salom");
  });

  it("no student with Telegram → the send button stays disabled", async () => {
    h.members = { data: [{ telegram_id: null }], error: null };
    render(<TeacherBroadcast />);
    typeMessage("Salom");
    await clickSend();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Bu guruhda Telegram'li o'quvchi yo'q");
    expect(screen.getByRole("button", { name: /Ha, yuborish/ })).toBeDisabled();
  });

  it("count fails → says so, beacons it, and still lets the teacher send (the fn is the source of truth)", async () => {
    h.members = { data: null, error: { code: "PGRST000", message: "boom" } };
    render(<TeacherBroadcast />);
    typeMessage("Salom");
    await clickSend();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("aniqlab bo'lmadi (guruhda ~3 ta o'quvchi)");
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "teacher_broadcast_count_failed" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Ha, yuborish/ })); });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("a rate-limited send shows the rate-limit copy and closes the confirmation", async () => {
    h.invoke.mockResolvedValue({
      data: null,
      error: { context: { json: () => Promise.resolve({ error: "rate_limited" }) } },
    });
    render(<TeacherBroadcast />);
    typeMessage("Salom");
    await clickSend();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Ha, yuborish/ })); });
    expect(screen.getByText(/Soatiga 1 marta xabar yuborish mumkin/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
