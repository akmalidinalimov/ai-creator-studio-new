import { describe, expect, it } from "vitest";
import { formatFileSize, homeworkFileKind, homeworkMaxBytes, HW_MAX_PHOTO_BYTES, pickedKind } from "./homeworkFiles";
import { pickPrompt } from "./homeworkBrief";

describe("homework files (mirror of submit-homework/media.ts)", () => {
  it("a PDF / Word file is homework too — it goes as a document", () => {
    expect(homeworkFileKind("application/pdf", 3_000_000)).toBe("document");
    expect(homeworkFileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10)).toBe("document");
    expect(homeworkFileKind("", 10)).toBe("document");
    expect(homeworkMaxBytes("document")).toBe(50 * 1024 * 1024);
  });
  it("photos and videos keep their own kinds; an oversize photo goes as a file", () => {
    expect(homeworkFileKind("image/jpeg", 1000)).toBe("photo");
    expect(homeworkFileKind("image/jpeg", HW_MAX_PHOTO_BYTES + 1)).toBe("document");
    expect(pickedKind("image/jpeg")).toBe("photo"); // picked: downscaled before upload
    expect(homeworkFileKind("video/mp4", 40_000_000)).toBe("video");
    expect(homeworkFileKind("image/heic", 1000)).toBe("document");
  });
  it("formats sizes", () => {
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatFileSize(300)).toBe("1 KB");
  });
});

describe("homework description precedence", () => {
  const row = { id: "a", parent_id: null, description: "D", prompt_uz: null, prompt_ru: "R", prompt_en: null };
  it("language prompt, then any prompt, then description (module 2 keeps its text in description)", () => {
    expect(pickPrompt(row, "ru")).toBe("R");
    expect(pickPrompt(row, "uz")).toBe("R");
    expect(pickPrompt({ ...row, prompt_ru: null }, "uz")).toBe("D");
    expect(pickPrompt(undefined, "uz")).toBe("");
  });
});

describe("waitForSubmission — checked against the row itself, never the phone clock (2026-10-08)", () => {
  const T0 = Date.parse("2026-10-08T10:00:00Z");
  const fake = (rows: Array<string | null | Error>) => {
    let t = T0, i = 0;
    return {
      read: async () => { const r = rows[Math.min(i++, rows.length - 1)]; if (r instanceof Error) throw r; return r; },
      opts: { everyMs: 5_000, maxMs: 30_000, now: () => t, sleep: async (ms: number) => { t += ms; } },
    };
  };
  const wait = async (...a: Parameters<typeof import("./homeworkFiles").waitForSubmission>) =>
    (await import("./homeworkFiles")).waitForSubmission(...a);
  it("a first submission: the row appearing at all is this upload", async () => {
    const f = fake([null, null, "2026-10-08T09:59:00Z"]);              // server clock may lag the phone: still counts
    expect(await wait(f.read, { baseline: null, startedMs: T0 }, f.opts)).toBe(true);
  });
  it("a resubmission: arrives when submitted_at moves past the old value; the old value alone is not it", async () => {
    const old = "2026-10-07T09:00:00Z";
    const f = fake([old, old, "2026-10-08T10:00:20Z"]);
    expect(await wait(f.read, { baseline: old, startedMs: T0 }, f.opts)).toBe(true);
    const stuck = fake([old]);
    expect(await wait(stuck.read, { baseline: old, startedMs: T0 }, stuck.opts)).toBe(false);
  });
  it("offline while checking → keeps trying; baseline unknown → phone clock with a wide margin", async () => {
    const f = fake([new Error("Failed to fetch"), "2026-10-08T10:00:12Z"]);
    expect(await wait(f.read, { baseline: "unknown", startedMs: T0 }, f.opts)).toBe(true);
    const never = fake([null]);
    expect(await wait(never.read, { baseline: null, startedMs: T0 }, never.opts)).toBe(false);
  });
});

describe("isFunctionNetworkError — the REAL functions-js errors", () => {
  it("a dropped connection (FunctionsFetchError, context = the TypeError) is a network error", async () => {
    const { FunctionsFetchError, FunctionsHttpError } = await import("@supabase/functions-js");
    const { isFunctionNetworkError } = await import("./homeworkFiles");
    expect(isFunctionNetworkError(new FunctionsFetchError(new TypeError("Failed to fetch")))).toBe(true);
    // an HTTP answer (e.g. 409 already_graded) is NOT — the app reads its code instead
    expect(isFunctionNetworkError(new FunctionsHttpError(new Response("{}", { status: 409 })))).toBe(false);
    expect(isFunctionNetworkError(null)).toBe(false);
  });
});
