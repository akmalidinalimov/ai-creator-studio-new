import { describe, it, expect, beforeEach } from "vitest";
import { mutate, mutateMany } from "@/lib/mutate";

// A fake single-row builder: mutate calls `.select(returning).maybeSingle()`.
function single(result: { data: any; error: any }) {
  return { select: () => ({ maybeSingle: () => Promise.resolve(result) }) };
}
// A fake single-row builder whose write rejects (e.g. the impersonation guard's rejected promise).
function singleRejects(err: Error) {
  return { select: () => ({ maybeSingle: () => Promise.reject(err) }) };
}
// A fake multi-row builder: mutateMany awaits `.select(returning)` directly.
function many(result: { data: any; error: any }) {
  return { select: () => Promise.resolve(result) };
}

describe("mutate (single-row guarded write)", () => {
  beforeEach(() => localStorage.clear());

  it("returns ok + row on a successful 1-row write", async () => {
    const r = await mutate(single({ data: { id: "abc" }, error: null }));
    expect(r).toEqual({ ok: true, row: { id: "abc" } });
  });

  it("returns not_saved on a 0-row write with NO error (the RLS-filtered silent no-op)", async () => {
    const r = await mutate(single({ data: null, error: null }));
    expect(r).toEqual({ ok: false, reason: "not_saved" });
  });

  it("returns error with the message on a real DB error", async () => {
    const r = await mutate(single({ data: null, error: { message: "boom" } }));
    expect(r).toEqual({ ok: false, reason: "error", message: "boom" });
  });

  it("returns impersonation_readonly (not a failure) while impersonating, without touching the write", async () => {
    localStorage.setItem("impersonating", "1");
    let touched = false;
    const guardedBuilder: any = { select: () => { touched = true; return { maybeSingle: async () => ({ data: null, error: null }) }; } };
    const r = await mutate(guardedBuilder);
    expect(r).toEqual({ ok: false, reason: "impersonation_readonly" });
    expect(touched).toBe(false); // never attempts the write during impersonation
  });

  it("maps a 'read-only impersonation' rejection to impersonation_readonly", async () => {
    const r = await mutate(singleRejects(new Error("read-only impersonation")));
    expect(r).toEqual({ ok: false, reason: "impersonation_readonly" });
  });

  it("maps any other rejection to error", async () => {
    const r = await mutate(singleRejects(new Error("network down")));
    expect(r).toEqual({ ok: false, reason: "error", message: "network down" });
  });
});

describe("mutateMany (bulk guarded write)", () => {
  beforeEach(() => localStorage.clear());

  it("returns ok + rows when all expected rows are written", async () => {
    const r = await mutateMany(many({ data: [{ id: "a" }, { id: "b" }], error: null }), { expected: 2 });
    expect(r).toEqual({ ok: true, rows: [{ id: "a" }, { id: "b" }] });
  });

  it("returns partial with the real count when RLS silently drops some rows", async () => {
    const r = await mutateMany(many({ data: [{ id: "a" }], error: null }), { expected: 3 });
    expect(r).toEqual({ ok: false, reason: "partial", count: 1 });
  });

  it("returns not_saved when zero rows were written", async () => {
    const r = await mutateMany(many({ data: [], error: null }), { expected: 2 });
    expect(r).toEqual({ ok: false, reason: "not_saved", count: 0 });
  });
});
