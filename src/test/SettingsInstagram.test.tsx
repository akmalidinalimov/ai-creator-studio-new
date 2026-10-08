import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Settings -> "Profil" card -> Instagram. Challenge 6.0 credits Instagram points by this handle, and the old
// save failed silently: an invalid handle showed "Saqlandi" while the DB kept the old value, a post/reel link
// was stored as "reel"/"p", and a handle another account had surfaced a raw English DB error AND lost the
// name edit saved in the same UPDATE. These tests drive the real page with the real write shapes.
type DbError = { code?: string; message: string } | null;
type Update = { payload: Record<string, unknown>; returning: string };
const h = vi.hoisted(() => ({
  profile: { name: "Ali", last_name: "Valiyev", timezone: "Asia/Tashkent", weekly_goal_lessons: 5, preferred_language: "uz", digest_opt_in: true },
  storedHandle: null as string | null,
  updates: [] as Update[],
  // What the Instagram UPDATE returns: default = the DB stores what was sent.
  igResult: null as null | { data: unknown; error: DbError },
  beacon: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
  auth: { user: { id: "u1", email: "ali@x.uz" }, signOut: vi.fn() },
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => h.auth }));
vi.mock("@/components/Layout", () => ({ PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/HomeworkProfileSection", () => ({ HomeworkProfileSection: () => null }));
vi.mock("@/components/NudgePreferencesCard", () => ({ NudgePreferencesCard: () => null }));
vi.mock("@/lib/beacon", () => ({ reportClientError: h.beacon }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let payload: Record<string, unknown> | null = null;
      let cols = "";
      const b: Record<string, unknown> = {
        select: (c: string) => { if (payload) { h.updates.push({ payload, returning: c }); } else { cols = c; } return b; },
        update: (p: Record<string, unknown>) => { payload = p; return b; },
        eq: () => b, order: () => b, limit: () => b,
        maybeSingle: () => {
          if (payload) {
            if ("instagram_username" in payload) {
              return Promise.resolve(h.igResult ?? { data: { id: "u1", instagram_username: payload.instagram_username }, error: null });
            }
            return Promise.resolve({ data: { id: "u1" }, error: null });
          }
          if (cols === "instagram_username") return Promise.resolve({ data: { instagram_username: h.storedHandle }, error: null });
          return Promise.resolve({ data: h.profile, error: null });
        },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === "auth_events" ? [] : null, error: null }).then(res, rej),
      };
      return b;
    },
    auth: { updateUser: vi.fn(), signOut: vi.fn() },
  },
}));

import i18n from "@/i18n";
import Settings from "@/pages/Settings";

// The columns #222's profiles_column_guard() rejects for a student (live profiles_guard_values(), 2026-09-30)
// plus the scoped active_teacher_group_id. No write from this page may carry one.
const GUARDED = ["telegram_id", "telegram_username", "email", "group_id", "status", "archived_at", "account_type",
  "telegram_write_access_at", "created_at", "active_teacher_group_id"];

async function openAndType(handle: string) {
  render(<MemoryRouter><Settings /></MemoryRouter>);
  const input = await screen.findByLabelText("Instagram");
  await waitFor(() => expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("Ali"));
  fireEvent.change(input, { target: { value: handle } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.saveProfile") }));
  return input as HTMLInputElement;
}

beforeEach(async () => {
  await i18n.changeLanguage("uz");
  h.storedHandle = null;
  h.updates = [];
  h.igResult = null;
  h.beacon.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

// 2026-10-08 (owner): no Instagram tasks any more, so Settings hides the field (SHOW_INSTAGRAM = false) and never
// writes the handle. The suite below pins the field's behaviour for the day it comes back (flip SHOW_INSTAGRAM and
// un-skip); the one after it pins today's behaviour.
describe("Settings — Instagram hidden (2026-10-08)", () => {
  it("there is no Instagram field, and saving never writes instagram_username (even with a stored handle)", async () => {
    h.storedHandle = "my.handle";
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await waitFor(() => expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("Ali"));
    expect(screen.queryByLabelText("Instagram")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.saveProfile") }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].payload).not.toHaveProperty("instagram_username");
    for (const col of GUARDED) expect(h.updates[0].payload).not.toHaveProperty(col);
  });
});

describe.skip("Settings — Instagram handle", () => {
  it("a reel link is refused BEFORE anything is written, with an Uzbek reason, and beaconed", async () => {
    await openAndType("https://www.instagram.com/reel/C8xYz12/?igsh=abc");
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.instagramErrors.not_profile_link"));
    expect(h.updates).toHaveLength(0);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({
      type: "other", message: "instagram_handle_rejected", extra: expect.objectContaining({ reason: "not_profile_link" }),
    }));
  });

  it("a handle with a space is refused (it used to say 'Saqlandi' and keep the old value)", async () => {
    await openAndType("my handle");
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.instagramErrors.bad_chars"));
    expect(h.updates).toHaveLength(0);
  });

  it("a valid handle: name saved first, then the NORMALIZED handle in its own write, read back, then 'Saqlandi'", async () => {
    const input = await openAndType("@My.Handle");
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(i18n.t("settings.saved")));
    expect(h.updates).toHaveLength(2);
    expect(h.updates[0].payload).not.toHaveProperty("instagram_username");
    expect(h.updates[0].payload).toMatchObject({ name: "Ali", last_name: "Valiyev" });
    expect(h.updates[1]).toEqual({ payload: { instagram_username: "my.handle" }, returning: "id,instagram_username" });
    expect(input.value).toBe("my.handle");
    expect(h.beacon).not.toHaveBeenCalled();
  });

  it("no write from this page touches a column #222's guard rejects for a student", async () => {
    await openAndType("@my.handle");
    await waitFor(() => expect(h.updates).toHaveLength(2));
    for (const u of h.updates) for (const k of Object.keys(u.payload)) expect(GUARDED).not.toContain(k);
  });

  it("an unchanged handle is not re-written", async () => {
    h.storedHandle = "my.handle";
    await openAndType("@My.Handle");
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].payload).not.toHaveProperty("instagram_username");
  });

  it("a handle another account has: Uzbek 'band' message, the name edit is still saved, beaconed", async () => {
    h.igResult = { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_profiles_instagram_username"' } };
    await openAndType("taken.one");
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.instagramErrors.taken"));
    expect(h.updates).toHaveLength(2);                       // the name/timezone write went through first
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith(i18n.t("settings.instagramErrors.taken"),
      { description: i18n.t("settings.instagramErrors.restSaved") });
    expect(String(h.toast.error.mock.calls[0][0])).not.toMatch(/duplicate key/);
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "instagram_handle_taken", extra: expect.objectContaining({ code: "23505" }) }));
  });

  it("the DB kept the old handle (it refused the value): never 'Saqlandi', the field shows what is stored", async () => {
    h.storedHandle = "old.handle";
    h.igResult = { data: { id: "u1", instagram_username: "old.handle" }, error: null };
    const input = await openAndType("new.handle");
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings.instagramErrors.notSaved"));
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(input.value).toBe("old.handle");
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "instagram_handle_not_stored" }));
  });

  it("a DB rule's own Uzbek refusal (P0001, e.g. a handle locked after an accepted Instagram task) is shown as written", async () => {
    h.storedHandle = "old.handle";
    const locked = "Instagram profilingizni o‘zgartirish uchun admin bilan bog‘laning";
    h.igResult = { data: null, error: { code: "P0001", message: locked } };
    await openAndType("new.handle");
    expect(await screen.findByRole("alert")).toHaveTextContent(locked);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "instagram_handle_save_failed", extra: expect.objectContaining({ code: "P0001" }) }));
  });

  it("clearing the field clears the handle (a blank is not an error)", async () => {
    h.storedHandle = "old.handle";
    await openAndType("   ");
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.updates[1].payload).toEqual({ instagram_username: null });
  });
});
