import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The Mini App grading card names the course and group (audit TUI-1): the Challenge 6.0 tasks are copies of
// the 5.0 tasks, so "Aziza · Modul 1 · Vazifa 1" alone could be either course.
const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/teacherApi", () => ({
  fetchPendingQueue: () => Promise.resolve(h.rows),
  submitScore: vi.fn(),
  returnForRedo: vi.fn(),
  notifyGradeVoice: vi.fn(),
  requestTeacherVoiceInTelegram: vi.fn(),
}));
vi.mock("@/hooks/useSelectedGroup", () => ({
  useSelectedGroup: () => ({ groups: [], groupId: null, setGroupId: vi.fn(), loading: false, error: false, reload: vi.fn() }),
}));
vi.mock("@/components/teacher/GradePhoto", () => ({ GradePhoto: () => null }));
vi.mock("@/components/homework/VoiceRecorder", () => ({ VoiceRecorder: () => null }));
vi.mock("@/lib/homeworkAudio", () => ({ uploadFeedbackVoice: vi.fn(), removeFeedbackVoice: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import TeacherGrade from "@/pages/teacher/TeacherGrade";

const row = (over: Record<string, unknown>) => ({
  submission_id: "s1", user_id: "u1", student_name: "Aziza Karimova (@aziza)", group_id: "g1",
  group_name: "AC CHALLENGE | 3-GURUH", module_number: 1, task_number: 1, assignment_id: "a6",
  assignment_title: "1- MODUL: PROMPT ENGINEERING", max_score: 10, submitted_at: new Date().toISOString(),
  previous_score: null, is_resubmission: false, media: null, submitted_image_url: null,
  course_id: "c6", course_title: "AI CREATORS CHALLENGE 6.0", ...over,
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

describe("TeacherGrade card label", () => {
  it("shows the course + group chip and 'M<n> V<step> — <title>'", async () => {
    h.rows = [row({})];
    renderPage();
    expect(await screen.findByText("CH6 · 3-GURUH")).toBeInTheDocument();
    expect(screen.getByText("M1 V1 — 1- MODUL: PROMPT ENGINEERING")).toBeInTheDocument();
  });

  it("the same task in 5.0 reads differently, in the course's own colour", async () => {
    h.rows = [row({ group_name: "1-GURUH VIP 5.0", course_id: "c5", course_title: "AI CREATORS 5.0", assignment_id: "a5" })];
    renderPage();
    const chip = await screen.findByText("5.0 · 1-GURUH VIP");
    expect(chip).toHaveAttribute("data-course-tone", "course");
  });

  it("a Challenge card's chip is in the Challenge colour", async () => {
    h.rows = [row({})];
    renderPage();
    expect(await screen.findByText("CH6 · 3-GURUH")).toHaveAttribute("data-course-tone", "challenge");
  });

  it("unknown course (lookup failed) → the group name alone, whole, neutral", async () => {
    h.rows = [row({ course_id: null, course_title: null })];
    renderPage();
    expect(await screen.findByText("AC CHALLENGE | 3-GURUH")).toHaveAttribute("data-course-tone", "unknown");
  });
});
