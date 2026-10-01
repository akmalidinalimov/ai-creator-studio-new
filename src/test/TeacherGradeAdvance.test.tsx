import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Audit TUI-6: the Mini App grading queue used to drop "whatever is at the head" after an awaited write. If the
// teacher tapped "Ortga" on the previous card's toast while the next grade was still saving, the re-opened card
// was removed instead of the one just graded — her correction vanished and the graded card stayed on screen.
type Toast = { action?: { label: string; onClick: () => void } };
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  graded: new Set<string>(),
  submitScore: vi.fn(),
  returnForRedo: vi.fn(),
  toasts: [] as Toast[],
}));

vi.mock("@/lib/teacherApi", () => ({
  // The server queue: everything not yet graded (a background reconcile() refetch sees the same truth).
  fetchPendingQueue: () => Promise.resolve(h.rows.filter((r) => !h.graded.has(r.submission_id as string))),
  submitScore: h.submitScore,
  returnForRedo: h.returnForRedo,
  notifyGradeVoice: vi.fn(),
  requestTeacherVoiceInTelegram: vi.fn(),
}));
// TeacherGrade reads the teacher's groups for its filter chips (#235); none are needed here.
vi.mock("@/hooks/useSelectedGroup", () => ({
  useSelectedGroup: () => ({ groups: [], groupId: null, setGroupId: vi.fn(), loading: false, error: false, reload: vi.fn() }),
}));
vi.mock("@/components/teacher/GradePhoto", () => ({ GradePhoto: () => null }));
vi.mock("@/components/homework/VoiceRecorder", () => ({ VoiceRecorder: () => null }));
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: vi.fn(), removeFeedbackVoice: vi.fn() }));
vi.mock("sonner", () => ({
  toast: {
    success: (_msg: string, opts?: Toast) => { h.toasts.push(opts ?? {}); },
    error: vi.fn(), info: vi.fn(), message: vi.fn(),
  },
}));

import TeacherGrade from "@/pages/teacher/TeacherGrade";

const row = (id: string, name: string) => ({
  submission_id: id, user_id: `u-${id}`, student_name: name, group_id: "g1", group_name: "1-GURUH VIP 5.0",
  module_number: 1, task_number: 1, assignment_id: "a1", assignment_title: "1-MODUL", max_score: 10,
  submitted_at: new Date().toISOString(), previous_score: null, is_resubmission: false, media: null,
  submitted_image_url: null, course_title: "AI CREATORS 5.0",
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TeacherGrade />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const chip = (v: number) => screen.getByRole("button", { name: String(v) });
const primary = () => screen.getByRole("button", { name: /Baholash → keyingi/ });

beforeEach(() => {
  h.rows = [row("A", "Aziza"), row("B", "Bobur"), row("C", "Charos")];
  h.graded = new Set();
  h.toasts = [];
  h.submitScore.mockReset();
  h.returnForRedo.mockReset();
});
afterEach(() => cleanup());

describe("TeacherGrade — advance removes the handled card by id (TUI-6)", () => {
  it("Ortga during an in-flight grade keeps the re-opened card and its restored score", async () => {
    renderPage();
    expect(await screen.findByText("Aziza")).toBeInTheDocument();

    // Grade A with 8 — resolves at once.
    h.submitScore.mockImplementationOnce(async (id: string) => { h.graded.add(id); return { status: "ok" }; });
    fireEvent.click(chip(8));
    await act(async () => { fireEvent.click(primary()); });
    expect(await screen.findByText("Bobur")).toBeInTheDocument();
    const undoA = h.toasts[0]?.action;
    expect(undoA?.label).toBe("Ortga");

    // Grade B with 10 — the write hangs until we release it.
    let releaseB: (v: { status: "ok" }) => void = () => {};
    h.submitScore.mockImplementationOnce(
      (id: string) => new Promise((res) => { releaseB = (v) => { h.graded.add(id); res(v); }; }),
    );
    fireEvent.click(chip(10));
    await act(async () => { fireEvent.click(primary()); });

    // While B is saving, the teacher taps "Ortga" on A's toast: A is back on screen with its 8 restored.
    await act(async () => { undoA!.onClick(); });
    expect(screen.getByText("Aziza")).toBeInTheDocument();
    expect(chip(8)).toHaveAttribute("aria-pressed", "true");

    // B's write returns. B leaves the queue; A (re-opened, score still restored) stays on screen.
    await act(async () => { releaseB({ status: "ok" }); });
    expect(screen.getByText("Aziza")).toBeInTheDocument();
    expect(screen.queryByText("Bobur")).not.toBeInTheDocument();
    expect(chip(8)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(h.submitScore.mock.calls.map((c) => [c[0], c[1]])).toEqual([["A", 8], ["B", 10]]);
  });

  it("a plain grade still advances to the next card with cleared inputs", async () => {
    renderPage();
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    h.submitScore.mockImplementationOnce(async (id: string) => { h.graded.add(id); return { status: "ok" }; });
    fireEvent.click(chip(9));
    await act(async () => { fireEvent.click(primary()); });
    expect(await screen.findByText("Bobur")).toBeInTheDocument();
    expect(chip(9)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("Qaytarish (return for redo) also removes exactly the returned card", async () => {
    renderPage();
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    h.returnForRedo.mockImplementationOnce(async () => { h.graded.add("A"); return { ok: true }; });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Qaytarish/ })); });
    expect(await screen.findByText("Bobur")).toBeInTheDocument();
    expect(screen.queryByText("Aziza")).not.toBeInTheDocument();
  });
});
