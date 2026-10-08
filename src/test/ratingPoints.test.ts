import { describe, expect, it } from "vitest";
import { contentRatingError, readContentRating } from "@/lib/ratingPoints";

describe("rating_points() parsing (content-only rating, Challenge 6.0)", () => {
  it("a content-only course gives the rating's own all-time and weekly points", () => {
    expect(readContentRating({ data: [{ content_only: true, points: 435, week_points: 60 }], error: null })).toEqual({ points: 435, week: 60 });
  });
  it("every other course, no group, a failed read or a malformed row → null (screens keep lifetime XP)", () => {
    expect(readContentRating({ data: [{ content_only: false, points: 900, week_points: 50 }], error: null })).toBeNull();
    expect(readContentRating({ data: [], error: null })).toBeNull();
    expect(readContentRating({ data: null, error: { code: "42883" } })).toBeNull();
    expect(readContentRating({ data: [{ content_only: true, points: null }], error: null })).toBeNull();
    expect(readContentRating(undefined)).toBeNull();
  });
  it("a missing weekly number keeps the all-time points", () => {
    expect(readContentRating({ data: { content_only: true, points: 20, week_points: null }, error: null })).toEqual({ points: 20, week: null });
  });
  it("only a real error is reported", () => {
    expect(contentRatingError({ error: { code: "42883", message: "function does not exist" } })).toBe("42883");
    expect(contentRatingError({ error: null })).toBeNull();
  });
});
