import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// saveInstagramHandle (Daily Tasks PR-7, spec G28): the Kunlik vazifalar page's handle field. A handle the DB did not
// keep, one another profile has, or one the guard locked must never read as saved — the same contract Settings has.
type DbError = { code?: string; message: string } | null;
const h = vi.hoisted(() => ({
  answer: null as null | { data: unknown; error: DbError },
  updates: [] as Array<{ payload: Record<string, unknown>; returning: string }>,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      let payload: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => { payload = p; return b; },
        eq: () => b,
        select: (c: string) => { if (payload) h.updates.push({ payload, returning: c }); return b; },
        maybeSingle: () => Promise.resolve(h.answer ?? { data: { id: "u1", instagram_username: payload?.instagram_username ?? null }, error: null }),
      };
      return b;
    },
  },
}));

import { saveInstagramHandle } from "@/lib/instagramHandleSave";

beforeEach(() => { h.answer = null; h.updates = []; window.localStorage.removeItem("impersonating"); });
afterEach(() => window.localStorage.removeItem("impersonating"));

describe("saveInstagramHandle", () => {
  it("normalizes, writes ONLY the handle and reads it back", async () => {
    expect(await saveInstagramHandle("u1", "https://www.instagram.com/My.Handle/?igsh=x", "")).toEqual({ ok: true, handle: "my.handle", changed: true });
    expect(h.updates).toEqual([{ payload: { instagram_username: "my.handle" }, returning: "id,instagram_username" }]);
  });
  it("an unchanged handle writes nothing", async () => {
    expect(await saveInstagramHandle("u1", "@my.handle", "my.handle")).toEqual({ ok: true, handle: "my.handle", changed: false });
    expect(h.updates).toHaveLength(0);
  });
  it("invalid input is refused before any write", async () => {
    expect(await saveInstagramHandle("u1", "https://www.instagram.com/reel/C8xYz12/", "")).toEqual({ ok: false, kind: "invalid", reason: "not_profile_link" });
    expect(h.updates).toHaveLength(0);
  });
  it("the DB kept the old value → not_stored (never 'saved')", async () => {
    h.answer = { data: { id: "u1", instagram_username: "old.one" }, error: null };
    expect(await saveInstagramHandle("u1", "new.one", "old.one")).toEqual({ ok: false, kind: "not_stored" });
  });
  it("another profile has it → taken; the guard's Uzbek rule → locked with its message", async () => {
    h.answer = { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_profiles_instagram_username"' } };
    expect(await saveInstagramHandle("u1", "taken.one", "")).toMatchObject({ ok: false, kind: "taken", code: "23505" });
    h.answer = { data: null, error: { code: "P0001", message: "Instagram profilingizni o‘zgartirish uchun admin bilan bog‘laning" } };
    expect(await saveInstagramHandle("u1", "other.one", "mine")).toMatchObject({ kind: "locked", message: "Instagram profilingizni o‘zgartirish uchun admin bilan bog‘laning" });
  });
  it("an admin preview is the expected no-op", async () => {
    window.localStorage.setItem("impersonating", "Ali");
    expect(await saveInstagramHandle("u1", "x.y", "")).toEqual({ ok: false, kind: "impersonation_readonly" });
    expect(h.updates).toHaveLength(0);
  });
});
