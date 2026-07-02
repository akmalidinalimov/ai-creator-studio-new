import { describe, it, expect } from "vitest";
import { isGenuineSignIn } from "@/lib/authEvents";

describe("isGenuineSignIn", () => {
  it("is true for a real sign-in (was logged out)", () => {
    expect(isGenuineSignIn("SIGNED_IN", null, "user-1")).toBe(true);
  });

  it("is true when switching to a different user", () => {
    expect(isGenuineSignIn("SIGNED_IN", "user-1", "user-2")).toBe(true);
  });

  it("is false for a tab-focus / re-emit of SIGNED_IN for the same user", () => {
    expect(isGenuineSignIn("SIGNED_IN", "user-1", "user-1")).toBe(false);
  });

  it("is false for a token refresh", () => {
    expect(isGenuineSignIn("TOKEN_REFRESHED", null, "user-1")).toBe(false);
  });

  it("is false for a page-reload session restore (INITIAL_SESSION)", () => {
    expect(isGenuineSignIn("INITIAL_SESSION", null, "user-1")).toBe(false);
  });

  it("is false for user-updated events", () => {
    expect(isGenuineSignIn("USER_UPDATED", "user-1", "user-1")).toBe(false);
  });
});
