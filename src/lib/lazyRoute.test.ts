import { describe, expect, it, vi } from "vitest";
import { chunkUrlFrom, healCachedAsset, makeLazyRouteLoader } from "./lazyRoute";

const MSG = "Failed to fetch dynamically imported module: https://www.aicreator.academy/assets/Dashboard-THIPsq7f.js";

describe("lazyRoute — stale-deploy recovery (2026-10-07 incident)", () => {
  it("finds the chunk URL in the browser's error message", () => {
    expect(chunkUrlFrom(new TypeError(MSG))).toBe("https://www.aicreator.academy/assets/Dashboard-THIPsq7f.js");
    expect(chunkUrlFrom(new Error("Unable to preload CSS for https://x.app/assets/a-1.css"))).toBe("https://x.app/assets/a-1.css");
    expect(chunkUrlFrom(new Error("boom"))).toBeNull();
  });

  it("re-fetches the poisoned chunk with cache: 'reload' (overwrites the cached HTML)", async () => {
    const f = vi.fn().mockResolvedValue(new Response("x"));
    await healCachedAsset("https://x.app/assets/a.js", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith("https://x.app/assets/a.js", expect.objectContaining({ cache: "reload" }));
    await healCachedAsset(null, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a failed chunk: heals it, reloads ONCE, and never resolves (no crash screen while the page reloads)", async () => {
    const heal = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockReturnValue(true);
    const load = makeLazyRouteLoader(() => Promise.reject(new TypeError(MSG)), { heal, reload });
    const settled = vi.fn();
    load().then(settled, settled);
    await new Promise((r) => setTimeout(r, 10));
    expect(heal).toHaveBeenCalledWith("https://www.aicreator.academy/assets/Dashboard-THIPsq7f.js");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
  });

  it("an import that resolved to nothing (prevented preload error) is treated as a failed chunk, not .default of undefined", async () => {
    const reload = vi.fn().mockReturnValue(true);
    const load = makeLazyRouteLoader(() => Promise.resolve(undefined as never), { heal: vi.fn().mockResolvedValue(undefined), reload });
    void load();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the loop guard tripped → the error reaches the ErrorBoundary; a real code error is never swallowed", async () => {
    const guarded = makeLazyRouteLoader(() => Promise.reject(new TypeError(MSG)), {
      heal: vi.fn().mockResolvedValue(undefined), reload: () => false,
    });
    await expect(guarded()).rejects.toThrow(/dynamically imported module/);
    const reload = vi.fn();
    const codeBug = makeLazyRouteLoader(() => Promise.reject(new ReferenceError("x is not defined")), { heal: vi.fn(), reload });
    await expect(codeBug()).rejects.toThrow("x is not defined");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a good chunk loads untouched", async () => {
    const C = () => null;
    const load = makeLazyRouteLoader(() => Promise.resolve({ default: C }), { heal: vi.fn(), reload: vi.fn() });
    await expect(load()).resolves.toEqual({ default: C });
  });
});
