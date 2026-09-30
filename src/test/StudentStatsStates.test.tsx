import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Home (Dashboard) and Profil read their numbers from profile_stats(uid). That RPC's caller gate is a WHERE
// clause, so a failed gate answers 200 + [] (a passing one always returns exactly one row). Before this fix
// an error or an empty answer rendered "0 XP · level 1 · Bronza" as if true, with nothing reported — and the
// Dashboard stored that as the celebration baseline, so the next good load showed a FALSE level-up and
// tier-up. Separately, a rank was shown for 0 points (profile_stats numbers an all-zero group by streak and
// uuid), so a Challenge 6.0 student saw an arbitrary "#17" on day 1.
type DbError = { code?: string; message: string } | null;
const h = vi.hoisted(() => ({
  stats: { data: [] as unknown, error: null as DbError },
  course: { data: "c6" as unknown, error: null as DbError },
  rating: { data: 0 as unknown, error: null as DbError },
  ratingCalls: [] as Array<Record<string, unknown>>,
  beacon: vi.fn(),
  auth: { user: { id: "u1" }, role: "student" },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ModuleCelebrationModal", () => ({ ModuleCelebrationModal: () => null }));
vi.mock("@/components/profile/TeacherProfile", () => ({ default: () => null }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => {
  const TABLES: Record<string, unknown> = {
    profiles: { name: "Ali", last_name: null, avatar_url: null, telegram_username: "ali", hide_from_group_boards: false },
    enrollments: [{ course_id: "c6", tier_id: null, courses: { id: "c6", title: "CHALLENGE 6.0", tagline: null, cover_url: null, duration_hours: null }, course_tiers: null }],
    lessons: [{ id: "l1", position: 1, title: "Dars 1", duration_seconds: 300, modules: { id: "m1", course_id: "c6", position: 1, title: "1-modul" } }],
    lesson_progress: [{ lesson_id: "l1", completed_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z" }],
    xp_events: [], homework_submissions: [], user_badges: [],
  };
  return {
    supabase: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "profile_stats") return Promise.resolve(h.stats);
        if (fn === "group_rating_course_id") return Promise.resolve(h.course);
        if (fn === "user_group_rating_xp") { h.ratingCalls.push(args); return Promise.resolve(h.rating); }
        if (fn === "daily_goal_progress") return Promise.resolve({ data: [{ target: 1, done: 0 }], error: null });
        if (fn === "public_profile") return Promise.resolve({ data: [{ group_name: "AC CHALLENGE | 1-GURUH" }], error: null });
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        const b: Record<string, unknown> = {
          select: () => b, eq: () => b, in: () => b, gte: () => b, order: () => b, limit: () => b,
          maybeSingle: () => Promise.resolve({ data: TABLES[table] ?? null, error: null }),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve({ data: TABLES[table] ?? [], error: null }).then(res, rej),
        };
        return b;
      },
    },
  };
});

import i18n from "@/i18n";
import Dashboard from "@/pages/Dashboard";
import Profile from "@/pages/Profile";

const statsRow = (o: Record<string, unknown> = {}) => ({
  total_xp: 1200, level: 5, group_rank: 17, group_size: 40, badges_earned: 2, current_streak: 3, ...o,
});
const rankTile = () => within(screen.getByText(i18n.t("home.statRank")).closest("div")!.parentElement!);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  h.stats = { data: [statsRow()], error: null };
  h.course = { data: "c6", error: null };
  h.rating = { data: 0, error: null };
  h.ratingCalls = [];
  h.beacon.mockReset();
});
afterEach(() => cleanup());

describe("Dashboard — a failed stats read is a failure, not zeros", () => {
  for (const [label, res, code] of [
    ["an error (timeout / grant regression)", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }, "57014"],
    ["an EMPTY answer (a failed caller gate)", { data: [], error: null }, "empty"],
  ] as const) {
    it(`${label}: the retry state, a beacon, and no celebration baseline`, async () => {
      localStorage.setItem("aic_seen_level:u1", "5");
      localStorage.setItem("aic_seen_tier:u1", "1000");
      h.stats = res as typeof h.stats;
      render(<MemoryRouter><Dashboard /></MemoryRouter>);
      expect(await screen.findByText(i18n.t("dashboard.loadError"))).toBeInTheDocument();
      expect(screen.getByRole("button", { name: i18n.t("common.retry") })).toBeInTheDocument();
      expect(screen.queryByText(i18n.t("home.statXp"))).toBeNull();
      expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({
        type: "other", message: "profile_stats_failed", extra: { code, surface: "dashboard" },
      }));
      // The baseline is untouched: the next good load cannot celebrate a level-up / tier-up that didn't happen.
      expect(localStorage.getItem("aic_seen_level:u1")).toBe("5");
      expect(localStorage.getItem("aic_seen_tier:u1")).toBe("1000");
    });
  }

  it("a good load renders the numbers and records the baseline", async () => {
    h.rating = { data: 250, error: null };
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText(i18n.t("home.statXp"))).toBeInTheDocument();
    expect(localStorage.getItem("aic_seen_level:u1")).toBe("5");
    expect(h.beacon).not.toHaveBeenCalled();
  });
});

describe("Dashboard — no rank without points", () => {
  it("rating 0 (a returning student with old lifetime XP, or day 1 of the challenge): '—', never '#17'", async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByText(i18n.t("home.statRank"));
    expect(h.ratingCalls).toEqual([{ _uid: "u1", _course_id: "c6" }]);
    expect(rankTile().getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("#17")).toBeNull();
  });

  it("rating > 0: the rank is shown", async () => {
    h.rating = { data: 35, error: null };
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText("#17")).toBeInTheDocument();
  });

  it("a failed rating read hides the rank and is beaconed", async () => {
    h.rating = { data: null, error: { code: "42501", message: "permission denied" } };
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByText(i18n.t("home.statRank"));
    expect(rankTile().getByText("—")).toBeInTheDocument();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "dashboard_rank_score_failed" }));
  });
});

describe("Profil — failed stats, and the 'edit my info' row", () => {
  it("an empty profile_stats answer shows the retry state and is beaconed (not 0 XP)", async () => {
    h.stats = { data: [], error: null };
    render(<MemoryRouter><Profile /></MemoryRouter>);
    expect(await screen.findByText(i18n.t("profile.loadError"))).toBeInTheDocument();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({
      type: "other", message: "profile_stats_failed", extra: { code: "empty", surface: "profile" },
    }));
  });

  it("the Profil tab has a 'Shaxsiy ma'lumotlar' row that opens the name / surname / Instagram editor", async () => {
    await i18n.changeLanguage("uz");
    render(<MemoryRouter><Profile /></MemoryRouter>);
    const row = await screen.findByRole("link", { name: /Shaxsiy ma'lumotlar/ });
    expect(row).toHaveAttribute("href", "/settings#profile");
    expect(row).toHaveTextContent("Instagram");
  });
});
