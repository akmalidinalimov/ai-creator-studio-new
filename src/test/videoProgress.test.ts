import { describe, it, expect, vi, beforeEach } from "vitest";

// The RPC and the beacon are both mocked: the tests drive the REAL supabase-js result shapes
// (a resolved `{ data:null, error, status }` for an HTTP error, `status: 0` for a rejected fetch, a
// REJECTED promise from the impersonation guard) through the real classifier + dedupe.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
vi.mock("@/lib/beacon", () => ({ reportClientError: vi.fn() }));

const L1 = "11111111-1111-1111-1111-111111111111";
const L2 = "22222222-2222-2222-2222-222222222222";
const TICK = { currentTime: 42, duration: 600, deltaSeconds: 5 };

// Fresh module graph per test so the once-per-lesson dedupe Set starts empty.
async function load() {
  vi.resetModules();
  const { supabase } = await import("@/integrations/supabase/client");
  const { reportClientError } = await import("@/lib/beacon");
  const mod = await import("@/lib/videoProgress");
  const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
  const beacon = reportClientError as unknown as ReturnType<typeof vi.fn>;
  rpc.mockReset(); // mock instances can outlive resetModules — start every test with clean call logs
  beacon.mockReset();
  return { rpc, beacon, ...mod };
}

const httpError = (status: number, error: Record<string, unknown>) =>
  Promise.resolve({ data: null, error, count: null, status, statusText: "" });

describe("trackVideoProgress (guarded track_video_progress tick)", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("returns the RPC data on success and never beacons", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockResolvedValue({ data: { completed: true, max_position_seconds: 42 }, error: null, status: 200 });
    const r = await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: true, data: { completed: true, max_position_seconds: 42 } });
    expect(rpc).toHaveBeenCalledWith("track_video_progress", {
      p_lesson_id: L1, p_current_time: 42, p_duration: 600, p_delta_seconds: 5,
    });
    expect(beacon).not.toHaveBeenCalled();
  });

  it("beacons a failing RPC ONCE per lesson with its Postgres code, and again for another lesson", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    // e.g. the function was dropped / re-signatured: PostgREST 404 PGRST202.
    rpc.mockImplementation(() => httpError(404, { code: "PGRST202", message: "Could not find the function public.track_video_progress", details: null, hint: null }));

    const r = await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: false, reason: "error", cls: "PGRST202" });
    await trackVideoProgress(L1, TICK); // the next 5s tick fails the same way
    await trackVideoProgress(L1, TICK);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({
      type: "other",
      message: "video_progress_rpc_failed:PGRST202",
      extra: expect.objectContaining({ lessonId: L1, code: "PGRST202", status: 404 }),
    }));

    await trackVideoProgress(L2, TICK);
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(beacon.mock.calls[1][0]).toMatchObject({ message: "video_progress_rpc_failed:PGRST202", extra: { lessonId: L2 } });
  });

  it("uses the RAISE text as the class for the function's own P0001 guards", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => httpError(400, { code: "P0001", message: "not authenticated", details: null, hint: null }));
    const r = await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: false, reason: "error", cls: "not_authenticated" });
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "video_progress_rpc_failed:not_authenticated" }));
  });

  it("reports a tier-lock rejection under a DISTINCT message that does not read as a failure", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => httpError(400, { code: "P0001", message: "module_locked", details: null, hint: null }));
    const r = await trackVideoProgress(L1, TICK);
    await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: false, reason: "module_locked", cls: "module_locked" });
    expect(beacon).toHaveBeenCalledTimes(1);
    const msg = beacon.mock.calls[0][0].message as string;
    expect(msg).toBe("video_progress_module_locked");
    expect(msg).not.toMatch(/failed/);

    // A real failure on the same lesson is a different signal and is still reported.
    rpc.mockImplementation(() => httpError(403, { code: "42501", message: "permission denied for function track_video_progress" }));
    await trackVideoProgress(L1, TICK);
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(beacon.mock.calls[1][0].message).toBe("video_progress_rpc_failed:42501");
  });

  it("never calls the RPC or beacons while an admin is impersonating (expected read-only no-op)", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    localStorage.setItem("impersonating", "1");
    const r = await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: false, reason: "impersonation_readonly", cls: "impersonation_readonly" });
    expect(rpc).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("maps the impersonation guard's REJECTION (toggle mid-flight) to a silent no-op, never throws", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => Promise.reject(new Error("read-only impersonation")));
    await expect(trackVideoProgress(L1, TICK)).resolves.toEqual({ ok: false, reason: "impersonation_readonly", cls: "impersonation_readonly" });
    expect(beacon).not.toHaveBeenCalled();
  });

  it("does not double-count a transport failure (status 0 — already beaconed as backend_unreachable)", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => httpError(0, { code: "", message: "TypeError: Failed to fetch", details: "", hint: "" }));
    const r = await trackVideoProgress(L1, TICK);
    expect(r).toEqual({ ok: false, reason: "network", cls: "network" });
    expect(beacon).not.toHaveBeenCalled();
  });

  it("classifies a non-JSON proxy error by HTTP status", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => httpError(502, { message: "<html>Bad Gateway</html>" }));
    await trackVideoProgress(L1, TICK);
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "video_progress_rpc_failed:http_502" }));
  });

  it("beacons an unexpected rejection as 'exception' and never throws", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    rpc.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(trackVideoProgress(L1, TICK)).resolves.toEqual({ ok: false, reason: "error", cls: "exception" });
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ message: "video_progress_rpc_failed:exception" }));
  });

  it("never puts DB text, tokens or ids in the beacon message", async () => {
    const { rpc, beacon, trackVideoProgress } = await load();
    const jwtish = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijk";
    rpc.mockImplementation(() => httpError(400, { code: "P0001", message: `bad token ${jwtish} for user 3f0c…`, details: null, hint: null }));
    await trackVideoProgress(L1, TICK);
    const call = beacon.mock.calls[0][0];
    expect(call.message).toBe("video_progress_rpc_failed:P0001"); // unsafe RAISE text → bare code only
    expect(JSON.stringify(call)).not.toContain("eyJ");                // token-shaped text dropped from extra too
  });
});

describe("classifyVideoProgressError", () => {
  it("covers each outcome", async () => {
    const { classifyVideoProgressError: c } = await load();
    expect(c({ message: "read-only impersonation" })).toEqual({ reason: "impersonation_readonly", cls: "impersonation_readonly" });
    expect(c({ code: "P0001", message: "module_locked" }, 400)).toEqual({ reason: "module_locked", cls: "module_locked" });
    expect(c({ code: "", message: "TypeError: Failed to fetch" }, 0)).toEqual({ reason: "network", cls: "network" });
    expect(c({ code: "PGRST303", message: "JWT expired" }, 401)).toEqual({ reason: "error", cls: "PGRST303" });
    expect(c({ code: "23503", message: "insert or update on table \"lesson_progress\" violates foreign key constraint" }, 409))
      .toEqual({ reason: "error", cls: "23503" });
    expect(c({ message: "gateway timeout" }, 504)).toEqual({ reason: "error", cls: "http_504" });
    expect(c(null, null)).toEqual({ reason: "error", cls: "unknown" });
  });
});
