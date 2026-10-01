import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The Baholash course + group filter (teacher audit PR-4, TUI-1), end to end on the page: a teacher of 5.0 and
// Challenge 6.0 can work one course or one group at a time, a typed score never moves to another student, an
// "Ortga" during another write re-opens the right card (TUI-6), and one-group teachers see no filter at all.
const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  groups: [] as unknown[],
  groupsLoading: false,
  fetch: vi.fn(),
  submit: vi.fn(),
  success: vi.fn(),
  upload: vi.fn(),
  notify: vi.fn(),
  // the onChange the recorder was last rendered with (a note that finishes encoding later calls this one)
  voiceOnChange: null as null | ((b: Blob | null) => void),
}));

vi.mock("@/lib/teacherApi", () => ({
  fetchPendingQueue: () => h.fetch(),
  submitScore: (...a: unknown[]) => h.submit(...a),
  returnForRedo: vi.fn(),
  notifyGradeVoice: (...a: unknown[]) => h.notify(...a),
  requestTeacherVoiceInTelegram: vi.fn(),
}));
vi.mock("@/hooks/useSelectedGroup", () => ({
  useSelectedGroup: () => ({
    groups: h.groups, groupId: null, setGroupId: vi.fn(), loading: h.groupsLoading, error: false, reload: vi.fn(),
  }),
}));
vi.mock("@/components/teacher/GradePhoto", () => ({ GradePhoto: () => null }));
// A stand-in recorder: one tap "records" a finished note (the real one needs a microphone).
vi.mock("@/components/homework/VoiceRecorder", async () => {
  const React = await import("react");
  return {
    VoiceRecorder: ({ onChange }: { onChange: (b: Blob | null) => void }) => {
      h.voiceOnChange = onChange;
      return React.createElement(
        "button",
        { type: "button", onClick: () => onChange(new Blob(["voice"], { type: "audio/mpeg" })) },
        "test-record",
      );
    },
  };
});
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: (...a: unknown[]) => h.upload(...a), removeFeedbackVoice: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn(), info: vi.fn(), message: vi.fn() } }));

import TeacherGrade from "@/pages/teacher/TeacherGrade";

const C5 = "AI CREATORS 5.0", C6 = "AI CREATORS CHALLENGE 6.0";
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const row = (id: string, name: string, groupId: string, groupName: string, courseId: string, courseTitle: string, hours: number) => ({
  submission_id: id, user_id: `u-${id}`, student_name: name, group_id: groupId, group_name: groupName, module_number: 1,
  task_number: 1, assignment_id: `a-${courseId}`, assignment_title: "1- MODUL: PROMPT ENGINEERING", max_score: 10,
  submitted_at: ago(hours), previous_score: null, is_resubmission: false, media: null, submitted_image_url: null,
  course_id: courseId, course_title: courseTitle,
});
const AZIZA = row("s1", "Aziza", "g5a", "1-GURUH VIP 5.0", "c5", C5, 3);
const BOBUR = row("s2", "Bobur", "g5b", "2-GURUH VIP 5.0", "c5", C5, 2);
const ELDOR = row("s3", "Eldor", "g6", "AC CHALLENGE | 3-GURUH", "c6", C6, 1);

// The page plus what TeacherShell puts around it: the bottom nav's "Baholash" tab (a <Link> to the SAME route, so
// the page does NOT remount — TeacherBottomNav.tsx) and a probe that shows the current ?query.
function LocationProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}
function renderPage(url = "/tg/teacher/grade") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A fresh element each time: re-rendering the same element object would be skipped by React.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <TeacherGrade />
        <Link to="/tg/teacher/grade">nav-baholash</Link>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(tree());
  return { ...r, rerender: () => r.rerender(tree()) };
}
const chip = (name: string) => screen.getByRole("button", { name });
const pressed = (name: string) => chip(name).getAttribute("aria-pressed") === "true";
const navTab = () => screen.getByRole("link", { name: "nav-baholash" });
const submitButton = () => screen.getByRole("button", { name: /Baholash → keyingi/ });
const search = () => screen.getByTestId("search").textContent;

beforeEach(() => {
  h.rows = [AZIZA, BOBUR, ELDOR];
  h.groups = [
    { id: "g5a", name: "1-GURUH VIP 5.0", courseName: C5 },
    { id: "g5b", name: "2-GURUH VIP 5.0", courseName: C5 },
    { id: "g6", name: "AC CHALLENGE | 3-GURUH", courseName: C6 },
  ];
  h.groupsLoading = false;
  h.fetch.mockReset();
  h.fetch.mockImplementation(() => Promise.resolve(h.rows));
  h.submit.mockReset();
  h.success.mockReset();
  h.upload.mockReset();
  h.notify.mockReset();
  h.voiceOnChange = null;
});

describe("TeacherGrade course + group filter", () => {
  it("starts at 'Hammasi' with per-course counts; the oldest card first", async () => {
    renderPage();
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("Hammasi (3)")).toBe(true);
    expect(chip("5.0 (2)")).toBeInTheDocument();
    expect(chip("CH6 (1)")).toBeInTheDocument();
    expect(chip("CH6 · 3-GURUH (1)")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("a course chip shows only that course's work", async () => {
    renderPage();
    await screen.findByText("Aziza");
    fireEvent.click(chip("CH6 (1)"));
    expect(await screen.findByText("Eldor")).toBeInTheDocument();
    expect(screen.queryByText("Aziza")).toBeNull();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(pressed("CH6 (1)")).toBe(true);
  });

  it("a group chip narrows to that group", async () => {
    renderPage();
    await screen.findByText("Aziza");
    fireEvent.click(chip("5.0 · 2-GURUH VIP (1)"));
    expect(await screen.findByText("Bobur")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
  });

  it("?course= in the URL (a link from Home) opens that course", async () => {
    renderPage("/tg/teacher/grade?course=c6");
    expect(await screen.findByText("Eldor")).toBeInTheDocument();
  });

  it("a stale ?course= shows everything, and leaves the URL", async () => {
    renderPage("/tg/teacher/grade?course=gone");
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("Hammasi (3)")).toBe(true);
    expect(search()).toBe("");
  });

  it("changing the filter clears a picked score, so it never lands on another student", async () => {
    renderPage();
    await screen.findByText("Aziza");
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(screen.getByRole("button", { name: "9" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("CH6 (1)"));
    await screen.findByText("Eldor");
    expect(screen.getByRole("button", { name: "9" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("grading the last item of a filter leaves 'Hammasini ko'rsatish' with the rest of the queue", async () => {
    h.submit.mockResolvedValue({ status: "ok" });
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Baholash → keyingi/ })); });
    expect(h.submit).toHaveBeenCalledWith("s3", 10, "", undefined);
    expect(await screen.findByText("Bu tanlovda ish qolmadi")).toBeInTheDocument();
    expect(chip("CH6 (0)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hammasini ko'rsatish (2)" }));
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
  });

  it("the filter is locked while a grade is being written", async () => {
    let finish: (v: unknown) => void = () => {};
    h.submit.mockReturnValue(new Promise((res) => { finish = res; }));
    renderPage();
    await screen.findByText("Aziza");
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    fireEvent.click(screen.getByRole("button", { name: /Baholash → keyingi/ }));
    expect(chip("CH6 (1)")).toBeDisabled();
    await act(async () => { finish({ status: "ok" }); });
    expect(chip("CH6 (1)")).not.toBeDisabled();
  });

  it("'Ortga' tapped while the NEXT grade is being written re-opens the right card and keeps its score (TUI-6)", async () => {
    renderPage();
    await screen.findByText("Aziza");
    // Grade Aziza 7 -> success toast with an "Ortga" action.
    h.submit.mockResolvedValueOnce({ status: "ok" });
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Baholash → keyingi/ })); });
    await screen.findByText("Bobur");
    const undo = h.success.mock.calls[0][1].action.onClick as () => void;
    // Start grading Bobur 10, and tap Aziza's "Ortga" before Bobur's write returns.
    let finish: (v: unknown) => void = () => {};
    h.submit.mockReturnValueOnce(new Promise((res) => { finish = res; }));
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    fireEvent.click(screen.getByRole("button", { name: /Baholash → keyingi/ }));
    act(() => undo());
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    await act(async () => { finish({ status: "ok" }); });
    // Aziza is still on screen with her restored 7; Bobur (graded) is gone from the queue.
    expect(screen.getByText("Aziza")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Bobur")).toBeNull();
  });

  it("'Ortga' after switching to another course widens back to 'Hammasi' so the re-opened card is the one on screen", async () => {
    h.submit.mockResolvedValueOnce({ status: "ok" });
    renderPage();
    await screen.findByText("Aziza");
    fireEvent.click(screen.getByRole("button", { name: "8" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Baholash → keyingi/ })); });
    fireEvent.click(chip("CH6 (1)"));
    await screen.findByText("Eldor");
    act(() => (h.success.mock.calls[0][1].action.onClick as () => void)());
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("Hammasi (3)")).toBe(true);
    expect(screen.getByRole("button", { name: "8" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("one course, one group: no filter bar", async () => {
    h.rows = [AZIZA];
    h.groups = [{ id: "g5a", name: "1-GURUH VIP 5.0", courseName: C5 }];
    renderPage();
    await screen.findByText("Aziza");
    expect(screen.queryByRole("button", { name: /^Hammasi/ })).toBeNull();
  });
});

// The entered score, feedback and voice note belong to the submission they were entered for. The card on screen
// can change without a chip tap — the bottom nav's "Baholash" tab (same route, no remount), a ?group= link that
// only resolves once the teacher's groups load, a background reconcile — and every one of those must clear them.
describe("TeacherGrade: the inputs never move to another student", () => {
  it("the bottom-nav tab changes the card (same route, no remount): the picked score is cleared", async () => {
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(chip("9"));
    expect(pressed("9")).toBe(true);
    fireEvent.click(navTab());
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("9")).toBe(false);
    expect(submitButton()).toBeDisabled();
  });

  it("the nav tab tapped while a grade is being written: the grade lands on its student, the new card starts clean", async () => {
    let finish: (v: unknown) => void = () => {};
    h.submit.mockReturnValueOnce(new Promise((res) => { finish = res; }));
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(chip("9"));
    fireEvent.click(submitButton());
    fireEvent.click(navTab());
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("9")).toBe(false);
    await act(async () => { finish({ status: "ok" }); });
    expect(h.submit.mock.calls).toEqual([["s3", 9, "", undefined]]);
    expect(screen.getByText("Aziza")).toBeInTheDocument();
    expect(pressed("9")).toBe(false);
    expect(submitButton()).toBeDisabled();
  });

  it("feedback and a voice note made for one student are never sent to the next one", async () => {
    h.submit.mockResolvedValue({ status: "ok" });
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(chip("Izoh qo'shish"));
    fireEvent.change(screen.getByPlaceholderText("Izoh (ixtiyoriy)"), { target: { value: "Eldor uchun izoh" } });
    fireEvent.click(chip("test-record"));
    fireEvent.click(navTab());
    await screen.findByText("Aziza");
    expect(screen.queryByPlaceholderText("Izoh (ixtiyoriy)")).toBeNull();
    fireEvent.click(chip("Izoh qo'shish"));
    expect((screen.getByPlaceholderText("Izoh (ixtiyoriy)") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(chip("10"));
    await act(async () => { fireEvent.click(submitButton()); });
    expect(h.submit.mock.calls).toEqual([["s1", 10, "", undefined]]);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.notify.mock.calls).toEqual([["s1", { voiceFresh: false }]]);
  });

  it("a voice note that finishes encoding after its card left the screen is not put on the new card", async () => {
    h.submit.mockResolvedValue({ status: "ok" });
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(chip("Izoh qo'shish"));
    const eldorsRecorder = h.voiceOnChange!;
    fireEvent.click(navTab());
    await screen.findByText("Aziza");
    act(() => eldorsRecorder(new Blob(["late"], { type: "audio/mpeg" })));
    // No "•" on Aziza's "Izoh qo'shish" (nothing attached), and her grade goes out without a note.
    expect(chip("Izoh qo'shish")).toBeInTheDocument();
    fireEvent.click(chip("10"));
    await act(async () => { fireEvent.click(submitButton()); });
    expect(h.submit.mock.calls).toEqual([["s1", 10, "", undefined]]);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("a voice note recorded before a nav tap during its save still reaches its own student's Telegram", async () => {
    let finish: (v: unknown) => void = () => {};
    h.submit.mockReturnValueOnce(new Promise((res) => { finish = res; }));
    h.upload.mockResolvedValue("u-s3/s3.mp3");
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Eldor");
    fireEvent.click(chip("Izoh qo'shish"));
    fireEvent.click(chip("test-record"));
    fireEvent.click(chip("8"));
    await act(async () => { fireEvent.click(submitButton()); });
    fireEvent.click(navTab());
    await screen.findByText("Aziza");
    await act(async () => { finish({ status: "ok" }); });
    expect(h.submit.mock.calls).toEqual([["s3", 8, "", "u-s3/s3.mp3"]]);
    expect(h.notify.mock.calls).toEqual([["s3", { voiceFresh: true }]]);
  });

  it("a stale ?course= leaves the URL, so the course's first new item cannot switch the card under a picked score", async () => {
    h.rows = [AZIZA, BOBUR];
    let deliver: (v: unknown) => void = () => {};
    h.fetch
      .mockImplementationOnce(() => Promise.resolve([AZIZA, BOBUR])) // first load: nothing of c6 waiting
      .mockImplementationOnce(() => new Promise((res) => { deliver = res; })); // the reconcile after Aziza's grade
    h.submit.mockResolvedValue({ status: "ok" });
    renderPage("/tg/teacher/grade?course=c6");
    await screen.findByText("Aziza");
    expect(pressed("Hammasi (2)")).toBe(true);
    expect(search()).toBe("");
    fireEvent.click(chip("10"));
    await act(async () => { fireEvent.click(submitButton()); });
    await screen.findByText("Bobur");
    fireEvent.click(chip("8"));
    // A co-teacher's student posts CH6 work; the reconcile brings it in.
    await act(async () => { deliver([BOBUR, ELDOR]); });
    expect(screen.getByText("Bobur")).toBeInTheDocument();
    expect(pressed("8")).toBe(true);
    await act(async () => { fireEvent.click(submitButton()); });
    expect(h.submit.mock.calls).toEqual([["s1", 10, "", undefined], ["s2", 8, "", undefined]]);
  });

  it("a ?group= of a group with nothing waiting is judged only once the teacher's groups have loaded", async () => {
    h.groupsLoading = true;
    const groups = h.groups;
    h.groups = [];
    const page = renderPage("/tg/teacher/grade?group=g5c");
    await screen.findByText("Aziza");
    fireEvent.click(chip("9"));
    // Still loading: the link is not thrown away.
    expect(search()).toBe("?group=g5c");
    h.groups = [...groups, { id: "g5c", name: "3-GURUH VIP 5.0", courseName: C5 }];
    h.groupsLoading = false;
    page.rerender();
    expect(await screen.findByText("Bu tanlovda ish qolmadi")).toBeInTheDocument();
    expect(search()).toBe("?group=g5c");
    fireEvent.click(chip("Hammasini ko'rsatish (3)"));
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(pressed("9")).toBe(false);
  });
});
