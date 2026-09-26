import { describe, it, expect } from "vitest";
import { rowsBeyondPage } from "@/lib/queuePage";

describe("rowsBeyondPage — how many rows a capped list left out", () => {
  it("reports the rows the cap cut off when the page is full", () => {
    expect(rowsBeyondPage(150, 100, 100)).toBe(50);
    expect(rowsBeyondPage(101, 100, 100)).toBe(1);
  });

  it("is 0 when the page is full and the count matches (nothing beyond it)", () => {
    expect(rowsBeyondPage(100, 100, 100)).toBe(0);
  });

  it("is 0 when the page is NOT full, even if the count is higher (a row arrived between the two requests)", () => {
    expect(rowsBeyondPage(41, 40, 100)).toBe(0);
    expect(rowsBeyondPage(0, 0, 100)).toBe(0);
  });

  it("never goes negative when the count is lower than the page (rows graded between the two requests)", () => {
    expect(rowsBeyondPage(97, 100, 100)).toBe(0);
  });

  it("degrades to 0 (today's view) when the count is unknown", () => {
    expect(rowsBeyondPage(null, 100, 100)).toBe(0);
    expect(rowsBeyondPage(undefined, 100, 100)).toBe(0);
    expect(rowsBeyondPage(Number.NaN, 100, 100)).toBe(0);
  });
});
