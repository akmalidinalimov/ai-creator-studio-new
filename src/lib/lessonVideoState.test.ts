import { describe, expect, it } from "vitest";
import { videoFetchOutcome, videoFetchStatus } from "./lessonVideoState";

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
