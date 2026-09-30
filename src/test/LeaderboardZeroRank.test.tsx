import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { displayRank, podiumRows } from "@/lib/studentStats";

// group_leaderboard numbers a group 1..N even when members have 0 points (ties broken by streak, then uuid).
// On day 1 of Challenge 6.0 only a few students will have scored, so a 🥈/🥉 next to 0 — or "#7" in the
// header for a student with nothing — would crown or rank people for nothing. Medals and ranks need >= 1.
const h = vi.hoisted(() => ({
  members: [] as unknown[],
  auth: { user: { id: "me" } },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/beacon", () => ({ reportClientError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (fn: string) => {
      if (fn === "group_leaderboard") return Promise.resolve({ data: h.members, error: null });
      if (fn === "public_profile") return Promise.resolve({ data: [{ group_name: "AC CHALLENGE | 1-GURUH" }], error: null });
      if (fn === "group_rating_course_id") return Promise.resolve({ data: "c6", error: null });
      if (fn === "user_group_rating_xp_since") return Promise.resolve({ data: 0, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import i18n from "@/i18n";
import Leaderboard from "@/pages/Leaderboard";

const m = (rank: number, id: string, name: string, xp: number, isMe = false) => ({
  rank, user_id: id, first_name: name, last_initial: "", total_xp: xp, level: 1, current_streak: 0, is_me: isMe,
});

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => cleanup());

describe("studentStats rank rules", () => {
  it("displayRank: a rank only for a score of at least 1", () => {
    expect(displayRank(3, 10)).toBe(3);
    expect(displayRank(3, 0)).toBeNull();
    expect(displayRank(3, -5)).toBeNull();
    expect(displayRank(3, null)).toBeNull();
    expect(displayRank(null, 10)).toBeNull();
    expect(displayRank(0, 10)).toBeNull();
  });
  it("podiumRows: the top three, but no medal for 0", () => {
    const rows = [m(1, "a", "A", 9), m(2, "b", "B", 0), m(3, "c", "C", 0), m(4, "d", "D", 0)];
    expect(podiumRows(rows).map((r) => r.user_id)).toEqual(["a"]);
    expect(podiumRows([m(1, "a", "A", 9), m(2, "b", "B", 4), m(3, "c", "C", 1)])).toHaveLength(3);
    expect(podiumRows([])).toEqual([]);
  });
});

describe("Leaderboard (Reyting) with partial zeros", () => {
  it("only scorers get a medal; a 0-point member is listed unranked; my 0-point rank chip is hidden", async () => {
    h.members = [m(1, "a", "Aziza", 12), m(2, "b", "Bobur", 0), m(3, "me", "Dilnoza", 0, true), m(4, "c", "Sardor", 0)];
    render(<MemoryRouter><Leaderboard /></MemoryRouter>);
    expect(await screen.findByText("Aziza")).toBeInTheDocument();
    expect(screen.getByText("👑")).toBeInTheDocument();
    expect(screen.queryByText("🥈")).toBeNull();
    expect(screen.queryByText("🥉")).toBeNull();
    expect(screen.queryByText("#3")).toBeNull();                 // the header rank chip for me (0 points)
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3); // Bobur, me, Sardor: unranked
  });

  it("everyone with points keeps medals and the header rank", async () => {
    h.members = [m(1, "a", "Aziza", 12), m(2, "me", "Dilnoza", 8, true), m(3, "b", "Bobur", 3), m(4, "c", "Sardor", 1)];
    render(<MemoryRouter><Leaderboard /></MemoryRouter>);
    expect(await screen.findByText("🥈")).toBeInTheDocument();
    expect(screen.getByText("🥉")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("an all-zero group (Challenge 6.0 day 1) shows 'no activity yet' and no rank chip", async () => {
    h.members = [m(1, "a", "Aziza", 0), m(2, "me", "Dilnoza", 0, true)];
    render(<MemoryRouter><Leaderboard /></MemoryRouter>);
    expect(await screen.findByText(i18n.t("leaderboard.noActivityTitle"))).toBeInTheDocument();
    expect(screen.queryByText("#2")).toBeNull();
    expect(screen.queryByText("👑")).toBeNull();
  });
});
