import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import uzLocale from "@/i18n/locales/uz.json";
import ruLocale from "@/i18n/locales/ru.json";
import enLocale from "@/i18n/locales/en.json";

// The /continue page: a spinner, then a replace-navigation to whatever the shared engine decides. The decision
// rules themselves are pinned in nextLesson.test.ts; here: the route params reach the engine, the page lands
// where it says, and a failure falls back to the dashboard.
const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const L = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

const h = vi.hoisted(() => ({ resolve: vi.fn(), fail: false, auth: { user: { id: "u1" }, role: "student", loading: false } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { tag: "sb" } }));
vi.mock("@/lib/nextLesson", () => ({
  resolveContinueTarget: (...a: unknown[]) => (h.fail ? Promise.reject(new Error("offline")) : h.resolve(...a)),
}));

import Continue from "@/pages/Continue";

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/continue" element={<Continue />} />
        <Route path="/continue/:courseId" element={<Continue />} />
        <Route path="/lesson/:c/:l" element={<div>LESSON</div>} />
        <Route path="/course/:c" element={<div>COURSE</div>} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { h.resolve.mockReset(); h.fail = false; });
afterEach(() => cleanup());

describe("Continue page", () => {
  it("normal: passes the course and lands on the next lesson", async () => {
    h.resolve.mockResolvedValue(`/lesson/${C}/${L}`);
    renderAt(`/continue/${C}`);
    expect(screen.getByText("continue.loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("LESSON")).toBeInTheDocument());
    expect(h.resolve.mock.calls[0][1]).toBe("u1");
    expect(h.resolve.mock.calls[0][2]).toEqual({ courseId: C, lessonId: null });
  });

  it("provisional: lands on the course page (the engine's answer)", async () => {
    h.resolve.mockResolvedValue(`/course/${C}`);
    renderAt(`/continue/${C}`);
    await waitFor(() => expect(screen.getByText("COURSE")).toBeInTheDocument());
  });

  it("not enrolled / nothing to watch: the dashboard", async () => {
    h.resolve.mockResolvedValue("/dashboard");
    renderAt("/continue");
    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    expect(h.resolve.mock.calls[0][2]).toEqual({ courseId: null, lessonId: null });
  });

  it("?lesson= is passed through", async () => {
    h.resolve.mockResolvedValue(`/lesson/${C}/${L}`);
    renderAt(`/continue?lesson=${L}`);
    await waitFor(() => expect(screen.getByText("LESSON")).toBeInTheDocument());
    expect(h.resolve.mock.calls[0][2]).toEqual({ courseId: null, lessonId: L });
  });

  it("a failure falls back to the dashboard (never a blank spinner)", async () => {
    h.fail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt(`/continue/${C}`);
    await waitFor(() => expect(screen.getByText("DASHBOARD")).toBeInTheDocument());
    err.mockRestore();
  });

  it("continue.loading exists, non-empty, in uz/ru/en", () => {
    for (const loc of [uzLocale, ruLocale, enLocale] as Array<{ continue?: { loading?: string } }>) {
      expect((loc.continue?.loading || "").trim().length).toBeGreaterThan(0);
    }
  });
});
