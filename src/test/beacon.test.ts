import { describe, it, expect, vi, beforeEach } from "vitest";

// Each test re-imports the module fresh (resetModules) so the module-level dedupe map + session
// counter start clean.
describe("reportClientError (client beacon)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}"))));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("dedupes an identical (type, message) within the window", async () => {
    const { reportClientError } = await import("@/lib/beacon");
    reportClientError({ type: "render_crash", message: "boom" });
    reportClientError({ type: "render_crash", message: "boom" });
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("sends distinct messages separately", async () => {
    const { reportClientError } = await import("@/lib/beacon");
    reportClientError({ type: "render_crash", message: "a" });
    reportClientError({ type: "render_crash", message: "b" });
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
  });

  it("posts to the /sb beacon endpoint with keepalive and never throws", async () => {
    const { reportClientError } = await import("@/lib/beacon");
    expect(() => reportClientError({ type: "chunk_load", message: "x" })).not.toThrow();
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/sb/functions/v1/client-beacon");
    expect(call[1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("never throws even with no message", async () => {
    const { reportClientError } = await import("@/lib/beacon");
    expect(() => reportClientError({ type: "other" })).not.toThrow();
  });
});
