import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The Haftalik (weekly) tab re-scores the group roster with user_group_rating_xp_since(). It must pass
// the course the group is scored by (group_rating_course_id, resolved server-side because `groups` is
// admin-only under RLS) — never a blanket null, which subtracts nothing and let a student enrolled in
// two courses carry the other course's lessons onto this tab only.
type DbError = { code?: string; message: string } | null;
const h = vi.hoisted(() => ({
  course: { data: "course-6" as unknown, error: null as DbError },
  sinceCalls: [] as Array<Record<string, unknown>>,
  beacon: vi.fn(),
  // ONE stable object: Leaderboard's effect depends on `user`, so a fresh object per render loops.
  auth: { user: { id: "u1" } },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("@/integrations/supabase/client", () => {
  const member = (id: string, name: string, xp: number, isMe: boolean) => ({
    rank: 0, user_id: id, first_name: name, last_initial: "", total_xp: xp, level: 1, current_streak: 0, is_me: isMe,
  });
  return {
    supabase: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "group_leaderboard") {
          return Promise.resolve({ data: [member("u1", "Ali", 300, true), member("u2", "Vali", 200, false)], error: null });
        }
        if (fn === "public_profile") return Promise.resolve({ data: [{ group_name: "Guruh 1" }], error: null });
        if (fn === "group_rating_course_id") return Promise.resolve(h.course);
        if (fn === "user_group_rating_xp_since") {
          h.sinceCalls.push(args);
          return Promise.resolve({ data: 5, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

import i18n from "@/i18n";
import Leaderboard from "@/pages/Leaderboard";

async function loadWeekly() {
  render(<MemoryRouter><Leaderboard /></MemoryRouter>);
  await waitFor(() => expect(h.sinceCalls).toHaveLength(2));
  // The page finished loading (the all-time board is on screen), not just fired the calls.
  expect(await screen.findByText(/Guruh 1/)).toBeInTheDocument();
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  h.course = { data: "course-6", error: null };
  h.sinceCalls = [];
  h.beacon.mockReset();
});
afterEach(() => cleanup());

describe("Leaderboard weekly tab — course scope", () => {
  it("scores every member by the group's course, never a blanket null", async () => {
    await loadWeekly();
    expect(h.sinceCalls.map((a) => a._course_id)).toEqual(["course-6", "course-6"]);
    expect(h.sinceCalls.map((a) => a._uid).sort()).toEqual(["u1", "u2"]);
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("a group without a course (NULL) passes null, like group_leaderboard's own fallback — no alarm", async () => {
    h.course = { data: null, error: null };
    await loadWeekly();
    expect(h.sinceCalls.map((a) => a._course_id)).toEqual([null, null]);
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("a failed lookup degrades to null but is beaconed, and the page still renders", async () => {
    h.course = { data: null, error: { code: "PGRST202", message: "function not found" } };
    await loadWeekly();
    expect(h.sinceCalls.map((a) => a._course_id)).toEqual([null, null]);
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({
      type: "other", message: "leaderboard_course_unresolved", extra: { code: "PGRST202" },
    }));
  });
});
