import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// /tg/teacher/grade?sub=<id> — the bot's 🎯 Baholash (new-homework DM, 24 h reminder) opens THAT submission first.
const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  gradeState: "graded" as "graded" | "unknown",
  fetchQueue: vi.fn(),
  gradeStateCalls: [] as string[],
  toastMessage: vi.fn(),
}));

vi.mock("@/lib/teacherApi", () => ({
  fetchPendingQueue: () => { h.fetchQueue(); return Promise.resolve(h.rows); },
  fetchSubmissionGradeState: (id: string) => { h.gradeStateCalls.push(id); return Promise.resolve(h.gradeState); },
  submitScore: vi.fn(),
  returnForRedo: vi.fn(),
  notifyGradeVoice: vi.fn(),
  requestTeacherVoiceInTelegram: vi.fn(),
}));
vi.mock("@/components/teacher/GradePhoto", () => ({ GradePhoto: () => null }));
vi.mock("@/components/homework/VoiceRecorder", () => ({ VoiceRecorder: () => null }));
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: vi.fn(), removeFeedbackVoice: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: h.toastMessage } }));

import TeacherGrade from "@/pages/teacher/TeacherGrade";

const A = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

const row = (id: string, name: string) => ({
  submission_id: id, user_id: `u-${id}`, student_name: name, group_id: "g1", group_name: "1-GURUH VIP 5.0",
  module_number: 1, task_number: 1, assignment_id: "a1", assignment_title: "Prompt", max_score: 10,
  submitted_at: new Date().toISOString(), previous_score: null, is_resubmission: false, media: null,
  submitted_image_url: null, course_title: "AI CREATORS 5.0",
});

let lastSearch = "";
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/tg/teacher/grade" element={<><TeacherGrade /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TeacherGrade ?sub= deep link", () => {
  beforeEach(() => {
    h.rows = [row(A, "Aziza Karimova (@aziza)"), row(B, "Bobur Aliyev (@bobur)")];
    h.gradeState = "graded";
    h.gradeStateCalls = [];
    h.fetchQueue.mockClear();
    h.toastMessage.mockClear();
    lastSearch = "";
  });

  it("without ?sub= the queue opens at its first item (unchanged)", async () => {
    renderAt("/tg/teacher/grade");
    expect(await screen.findByText("Aziza Karimova (@aziza)")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(h.gradeStateCalls).toEqual([]);
  });

  it("?sub=<id> opens THAT submission first, then drops the param — once, without a second queue load", async () => {
    renderAt(`/tg/teacher/grade?sub=${B}`);
    expect(await screen.findByText("Bobur Aliyev (@bobur)")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await waitFor(() => expect(lastSearch).toBe(""));
    expect(h.fetchQueue).toHaveBeenCalledTimes(1);
    expect(h.toastMessage).not.toHaveBeenCalled();
  });

  it("a submission a co-teacher already graded → 'allaqachon baholangan' toast, the queue as usual", async () => {
    renderAt("/tg/teacher/grade?sub=22222222-2222-4222-8222-222222222222");
    expect(await screen.findByText("Aziza Karimova (@aziza)")).toBeInTheDocument();
    await waitFor(() => expect(h.toastMessage).toHaveBeenCalledWith("Bu ish allaqachon baholangan", expect.anything()));
    expect(h.gradeStateCalls).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("not in the queue for another reason → the neutral 'navbatingizda yo'q' toast", async () => {
    h.gradeState = "unknown";
    renderAt("/tg/teacher/grade?sub=22222222-2222-4222-8222-222222222222");
    await waitFor(() => expect(h.toastMessage).toHaveBeenCalledWith("Bu ish navbatingizda yo'q", expect.anything()));
  });

  it("a malformed ?sub= is ignored (no lookup, no toast)", async () => {
    renderAt("/tg/teacher/grade?sub=1;drop");
    expect(await screen.findByText("Aziza Karimova (@aziza)")).toBeInTheDocument();
    expect(h.gradeStateCalls).toEqual([]);
    expect(h.toastMessage).not.toHaveBeenCalled();
  });
});
