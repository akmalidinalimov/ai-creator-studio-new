import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// TeacherHome's per-course counts (teacher audit PR-4): a teacher of 5.0 and Challenge 6.0 sees how much waits in
// each course; a course with work opens the grading queue filtered to it; one-course teachers see no extra row.
const h = vi.hoisted(() => ({
  pending: { count: 0, byCourse: [] as unknown[], loading: false },
  groups: [] as unknown[],
  auth: { user: { id: "t1" } }, // one stable object: TeacherHome's load effect depends on `user`
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/hooks/usePendingGrading", () => ({ usePendingGrading: () => h.pending }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: "Rano" }, error: null }) }) }) }),
    rpc: () => Promise.resolve({ data: h.groups, error: null }),
  },
}));

import TeacherHome from "@/pages/teacher/TeacherHome";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/tg/teacher"]}>
        <Routes>
          <Route path="/tg/teacher" element={<TeacherHome />} />
          <Route path="/tg/teacher/grade" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const G = (id: string, name: string, course: string) => ({ group_id: id, group_name: name, course_name: course, total_students: 10, active_7d: 5 });

beforeEach(() => {
  h.pending = { count: 0, byCourse: [], loading: false };
  h.groups = [];
});

describe("TeacherHome per-course counts", () => {
  it("two courses with work: one chip per course with its count; a chip opens Baholash on that course", async () => {
    h.pending = {
      count: 5,
      loading: false,
      byCourse: [
        { id: "c5", title: "AI CREATORS 5.0", short: "5.0", count: 3 },
        { id: "c6", title: "AI CREATORS CHALLENGE 6.0", short: "CH6", count: 2 },
      ],
    };
    h.groups = [G("g5", "1-GURUH VIP 5.0", "AI CREATORS 5.0"), G("g6", "AC CHALLENGE | 3-GURUH", "AI CREATORS CHALLENGE 6.0")];
    renderHome();
    const ch6 = await screen.findByRole("button", { name: /CH6/ });
    expect(ch6).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^5\.0/ })).toHaveTextContent("3");
    fireEvent.click(ch6);
    expect(await screen.findByTestId("where")).toHaveTextContent("/tg/teacher/grade?course=c6");
  });

  it("a course the teacher has a group in but no work from shows 0 and is not a link", async () => {
    h.pending = { count: 3, loading: false, byCourse: [{ id: "c5", title: "AI CREATORS 5.0", short: "5.0", count: 3 }] };
    h.groups = [G("g5", "1-GURUH VIP 5.0", "AI CREATORS 5.0"), G("g6", "AC CHALLENGE | 3-GURUH", "AI CREATORS CHALLENGE 6.0")];
    renderHome();
    await screen.findByRole("button", { name: /^5\.0/ });
    expect(screen.queryByRole("button", { name: /CH6/ })).toBeNull();
    expect(screen.getByTitle("AI CREATORS CHALLENGE 6.0: kutayotgan ish yo'q")).toHaveTextContent("CH60");
  });

  it("one course: no per-course row", async () => {
    h.pending = { count: 3, loading: false, byCourse: [{ id: "c5", title: "AI CREATORS 5.0", short: "5.0", count: 3 }] };
    h.groups = [G("g5", "1-GURUH VIP 5.0", "AI CREATORS 5.0"), G("g5b", "2-GURUH VIP 5.0", "AI CREATORS 5.0")];
    renderHome();
    expect(await screen.findByText("3 ta ish sizni kutmoqda")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Kurslar bo'yicha kutilmoqda" })).toBeNull();
  });
});
