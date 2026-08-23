import { describe, it, expect } from "vitest";
import type { User } from "@supabase/supabase-js";
import { isGenuineSignIn, stableUser } from "@/lib/authEvents";

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

describe("stableUser", () => {
  const mk = (id: string) => ({ id }) as User;

  it("keeps the SAME reference on a token refresh (same id) — no consumer churn", () => {
    const prev = mk("user-1");
    const next = mk("user-1"); // supabase hands us a brand-new object
    expect(stableUser("TOKEN_REFRESHED", prev, next)).toBe(prev);
  });

  it("keeps the SAME reference on a tab-focus SIGNED_IN re-emit (same id)", () => {
    const prev = mk("user-1");
    expect(stableUser("SIGNED_IN", prev, mk("user-1"))).toBe(prev);
  });

  it("swaps to the new object on a genuine USER_UPDATED (contents may have changed)", () => {
    const prev = mk("user-1");
    const next = mk("user-1");
    expect(stableUser("USER_UPDATED", prev, next)).toBe(next);
  });

  it("swaps when the user identity actually changes", () => {
    const prev = mk("user-1");
    const next = mk("user-2");
    expect(stableUser("SIGNED_IN", prev, next)).toBe(next);
  });

  it("returns the new user on first sign-in (no previous)", () => {
    const next = mk("user-1");
    expect(stableUser("SIGNED_IN", null, next)).toBe(next);
  });

  it("returns null on sign-out", () => {
    expect(stableUser("SIGNED_OUT", mk("user-1"), null)).toBeNull();
  });
});
