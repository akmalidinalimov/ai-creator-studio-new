import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mutable auth holder the mocked useAuth() reads from (hoisted so vi.mock can see it).
const h = vi.hoisted(() => ({
  auth: { user: null as any, role: null as any, loading: false },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { RequireAuth } from "@/components/RequireAuth";

function renderGuard(props: { adminOnly?: boolean; staffOnly?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={["/protected"]}>
      <Routes>
        <Route path="/protected" element={<RequireAuth {...props}><div>PROTECTED</div></RequireAuth>} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/dashboard" element={<div>STUDENT_HOME</div>} />
        <Route path="/admin/dashboard" element={<div>ADMIN_HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const asUser = (role: string | null) => ({ user: { id: "u1" }, role, loading: false });

describe("RequireAuth gating", () => {
  beforeEach(() => { h.auth = { user: null, role: null, loading: false }; });

  it("shows a loading state (no redirect, no children) while auth resolves", () => {
    h.auth = { user: null, role: null, loading: true };
    renderGuard();
    expect(screen.queryByText("PROTECTED")).not.toBeInTheDocument();
    expect(screen.queryByText("LOGIN")).not.toBeInTheDocument();
  });

  it("redirects an unauthenticated visitor to /login", () => {
    renderGuard();
    expect(screen.getByText("LOGIN")).toBeInTheDocument();
  });

  it("renders children for any logged-in user when no role flag is set", () => {
    h.auth = asUser("student");
    renderGuard();
    expect(screen.getByText("PROTECTED")).toBeInTheDocument();
  });

  // adminOnly
  it("adminOnly: admin passes", () => {
    h.auth = asUser("admin");
    renderGuard({ adminOnly: true });
    expect(screen.getByText("PROTECTED")).toBeInTheDocument();
  });
  it("adminOnly: teacher is bounced to the admin dashboard (not the student home)", () => {
    h.auth = asUser("teacher");
    renderGuard({ adminOnly: true });
    expect(screen.getByText("ADMIN_HOME")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED")).not.toBeInTheDocument();
  });
  it("adminOnly: student is bounced to the student home", () => {
    h.auth = asUser("student");
    renderGuard({ adminOnly: true });
    expect(screen.getByText("STUDENT_HOME")).toBeInTheDocument();
  });

  // staffOnly
  it("staffOnly: admin passes", () => {
    h.auth = asUser("admin");
    renderGuard({ staffOnly: true });
    expect(screen.getByText("PROTECTED")).toBeInTheDocument();
  });
  it("staffOnly: teacher passes", () => {
    h.auth = asUser("teacher");
    renderGuard({ staffOnly: true });
    expect(screen.getByText("PROTECTED")).toBeInTheDocument();
  });
  it("staffOnly: student is bounced to the student home", () => {
    h.auth = asUser("student");
    renderGuard({ staffOnly: true });
    expect(screen.getByText("STUDENT_HOME")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED")).not.toBeInTheDocument();
  });
});
