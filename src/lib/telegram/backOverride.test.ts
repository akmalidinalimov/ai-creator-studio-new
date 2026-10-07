import { describe, expect, it } from "vitest";
import { activeTelegramBackOverride, pushTelegramBackOverride } from "./useTelegramBackButton";

describe("Telegram native ← overrides (an open sheet owns the back button)", () => {
  it("the newest overlay wins; closing it hands the button back", () => {
    expect(activeTelegramBackOverride()).toBeNull();
    const calls: string[] = [];
    const popSheet = pushTelegramBackOverride(() => calls.push("sheet"));
    const popInner = pushTelegramBackOverride(() => calls.push("inner"));
    activeTelegramBackOverride()!();
    popInner();
    activeTelegramBackOverride()!();
    popSheet();
    expect(calls).toEqual(["inner", "sheet"]);
    expect(activeTelegramBackOverride()).toBeNull(); // back to normal page navigation
  });

  it("unregistering twice or out of order never removes someone else's handler", () => {
    const a = () => {};
    const b = () => {};
    const popA = pushTelegramBackOverride(a);
    const popB = pushTelegramBackOverride(b);
    popA();
    popA();
    expect(activeTelegramBackOverride()).toBe(b);
    popB();
    expect(activeTelegramBackOverride()).toBeNull();
  });
});
