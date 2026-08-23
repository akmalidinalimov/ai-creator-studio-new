import { describe, it, expect } from "vitest";
import { watchedEnough } from "@/lib/watchGate";

describe("watchedEnough (lesson completion gate)", () => {
  it("allows a text / homework lesson (nothing to watch)", () => {
    expect(watchedEnough({ isTextLesson: true, durationSeconds: 0, watchedSeconds: 0 })).toBe(true);
  });

  it("BLOCKS an un-played video (unknown duration, no watch time) — the reported bug", () => {
    // Bunny reports no duration until played; the old gate wrongly returned true here,
    // letting "Next" / "Mark complete" mark an unwatched video as watched.
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 0, watchedSeconds: 0 })).toBe(false);
  });

  it("BLOCKS a barely-touched video (25s of a known 520s lesson — Raisa's 1.4)", () => {
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 520, watchedSeconds: 25 })).toBe(false);
  });

  it("allows a video watched at least half", () => {
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 600, watchedSeconds: 300 })).toBe(true);
  });

  it("blocks a video watched under half", () => {
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 600, watchedSeconds: 299 })).toBe(false);
  });

  it("allows when duration is unknown but there is real watch time (>= 60s) — player didn't report duration", () => {
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 0, watchedSeconds: 90 })).toBe(true);
  });

  it("blocks when duration is unknown and watch time is under a minute", () => {
    expect(watchedEnough({ isTextLesson: false, durationSeconds: 0, watchedSeconds: 40 })).toBe(false);
  });
});
