import { describe, it, expect } from "vitest";
import { tierFor, xpToNextTier } from "./xp";

describe("tiers (0/300/600/1000/1500)", () => {
  it("840 XP is Gold, 160 to Platinum", () => {
    expect(tierFor(840).key).toBe("gold");
    expect(xpToNextTier(840)).toBe(160);
  });
  it("0 XP is Bronze; 1500+ is Diamond with no next", () => {
    expect(tierFor(0).key).toBe("bronze");
    expect(tierFor(1600).key).toBe("diamond");
    expect(xpToNextTier(1600)).toBeNull();
  });
});
