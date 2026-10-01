import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// «Eslatmalar kimga boradi» — the owner's engagement_targeting switches. Drives the real card against a mocked
// Supabase with the real write shape: one guarded upsert of platform_settings.engagement_targeting that keeps the
// row's other keys; a 0-row (RLS-filtered) write is "Saqlanmadi" and the switch does not move; a value that could
// not be read is never written over.
type Res = { data: unknown; error: { message: string } | null };
const h = vi.hoisted(() => ({
  load: { data: null, error: null } as Res,
  upsertResult: null as Res | null,
  upserts: [] as Array<{ payload: Record<string, unknown>; opts: unknown; returning: string }>,
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "admin-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      expect(table).toBe("platform_settings");
      let up: { payload: Record<string, unknown>; opts: unknown } | null = null;
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          if (up) h.upserts.push({ ...up, returning: cols });
          return b;
        },
        eq: () => b,
        upsert: (payload: Record<string, unknown>, opts: unknown) => {
          up = { payload, opts };
          return b;
        },
        maybeSingle: () => {
          if (up) return Promise.resolve(h.upsertResult ?? { data: { key: up.payload.key }, error: null });
          return Promise.resolve(h.load);
        },
      };
      return b;
    },
  },
}));

import { EngagementTargetingCard } from "@/components/admin/EngagementTargetingCard";

const sw = (name: RegExp) => screen.getByRole("switch", { name });
const CLOSED = /Yopiq kurs/;
const TRIAL = /Sinov \(trial\)/;
const RETIRE = /3 va 7 kunlik/;

beforeEach(() => {
  h.load = { data: { value: { skip_closed_courses: true, note: "owner" } }, error: null };
  h.upsertResult = null;
  h.upserts = [];
  Object.values(h.toast).forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

describe("EngagementTargetingCard", () => {
  it("shows each switch as stored: only a JSON true is on", async () => {
    h.load = { data: { value: { skip_closed_courses: true, trial_to_course_page: "true" } }, error: null };
    render(<EngagementTargetingCard />);
    await waitFor(() => expect(sw(CLOSED).getAttribute("aria-checked")).toBe("true"));
    expect(sw(TRIAL).getAttribute("aria-checked")).toBe("false");
    expect(sw(RETIRE).getAttribute("aria-checked")).toBe("false");
    expect(sw(RETIRE)).not.toBeDisabled();
  });

  it("a flip is one upsert of the whole row that keeps the other keys, then the switch shows it", async () => {
    render(<EngagementTargetingCard />);
    await waitFor(() => expect(sw(RETIRE)).not.toBeDisabled());
    fireEvent.click(sw(RETIRE));
    await waitFor(() => expect(sw(RETIRE).getAttribute("aria-checked")).toBe("true"));
    expect(h.upserts).toHaveLength(1);
    const u = h.upserts[0];
    expect(u.payload.key).toBe("engagement_targeting");
    expect(u.payload.value).toEqual({ skip_closed_courses: true, note: "owner", retire_smart_inactive_nudges: true });
    expect(u.payload.updated_by).toBe("admin-1");
    expect(u.opts).toEqual({ onConflict: "key" });
    expect(u.returning).toBe("key");
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("an absent row starts all off, and the first flip creates it", async () => {
    h.load = { data: null, error: null };
    render(<EngagementTargetingCard />);
    await waitFor(() => expect(sw(CLOSED)).not.toBeDisabled());
    expect(sw(CLOSED).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw(CLOSED));
    await waitFor(() => expect(h.upserts).toHaveLength(1));
    expect(h.upserts[0].payload.value).toEqual({ skip_closed_courses: true });
  });

  it("a 0-row (RLS-filtered) write is 'Saqlanmadi' and the switch does not move", async () => {
    h.upsertResult = { data: null, error: null };
    render(<EngagementTargetingCard />);
    await waitFor(() => expect(sw(TRIAL)).not.toBeDisabled());
    fireEvent.click(sw(TRIAL));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Saqlanmadi"));
    expect(sw(TRIAL).getAttribute("aria-checked")).toBe("false");
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("an unreadable row is never written over: switches disabled, a visible error", async () => {
    h.load = { data: null, error: { message: "permission denied" } };
    render(<EngagementTargetingCard />);
    await screen.findByText(/Sozlamani oʻqib boʻlmadi/);
    expect(sw(CLOSED)).toBeDisabled();
    fireEvent.click(sw(CLOSED));
    expect(h.upserts).toHaveLength(0);
  });
});
