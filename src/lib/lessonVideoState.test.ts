import { describe, expect, it } from "vitest";
import { videoErrorBody, videoFetchOutcome, videoFetchStatus, videoLockOf } from "./lessonVideoState";

// Shapes of supabase-js functions.invoke errors: FunctionsHttpError / FunctionsRelayError carry the Response in
// .context; FunctionsFetchError (no network) carries the original error, which has no status.
const http = (status: number) => ({ name: "FunctionsHttpError", context: { status } });

describe("videoFetchOutcome", () => {
  it("a video answer is ok", () => {
    expect(videoFetchOutcome(null, { url: "https://x", kind: "iframe" })).toBe("ok");
  });
  it("only a 403 (the server's access verdict) is 'not in your plan'", () => {
    expect(videoFetchOutcome(http(403), null)).toBe("locked");
  });
  it("no network is a retryable failure, not a plan lock (the 2026-10-04 report)", () => {
    expect(videoFetchOutcome({ name: "FunctionsFetchError", context: new TypeError("Load failed") }, null)).toBe("failed");
  });
  it("a 5xx, a 401 or an empty answer is a failure too", () => {
    expect(videoFetchOutcome(http(500), null)).toBe("failed");
    expect(videoFetchOutcome(http(401), null)).toBe("failed");
    expect(videoFetchOutcome(null, null)).toBe("failed");
  });
  it("videoFetchStatus reads the status when there is one", () => {
    expect(videoFetchStatus(http(502))).toBe(502);
    expect(videoFetchStatus({ name: "FunctionsFetchError", context: new TypeError("x") })).toBeNull();
    expect(videoFetchStatus(null)).toBeNull();
  });
});

describe("videoLockOf (20261030145000)", () => {
  it("a not_member 403 is the rejoin lock, with the channel link (t.me only)", () => {
    expect(videoLockOf({ error: "not_member", join_url: "https://t.me/+srXusW0zCM41NDg0" }))
      .toEqual({ code: "not_member", joinUrl: "https://t.me/+srXusW0zCM41NDg0" });
    expect(videoLockOf({ error: "not_member", join_url: "javascript:alert(1)" })).toEqual({ code: "not_member", joinUrl: null });
    expect(videoLockOf({ error: "not_member" })).toEqual({ code: "not_member", joinUrl: null });
  });
  it("every other 403 (tier, trial, unreadable) is the plain lock", () => {
    for (const b of [{ error: "module_locked" }, { error: "provisional_locked" }, null, "x", {}]) {
      expect(videoLockOf(b).code).toBe("locked");
    }
  });
  it("videoErrorBody reads the Response JSON, else null", async () => {
    expect(await videoErrorBody({ context: new Response(JSON.stringify({ error: "not_member" }), { status: 403 }) }))
      .toEqual({ error: "not_member" });
    expect(await videoErrorBody({ context: new TypeError("x") })).toBeNull();
    expect(await videoErrorBody(null)).toBeNull();
  });
});
