import { describe, it, expect } from "vitest";
import { translateAuthError } from "@/lib/authErrors";
import type { TFunction } from "i18next";

// Regression: ISSUE-003 — raw English Supabase auth errors shown in uz/ru UI
// Found by /qa on 2026-07-05
// Report: .gstack/qa-reports/qa-report-genius-loom-space-lovable-app-2026-07-05.md

const t = ((key: string) => `t:${key}`) as TFunction;

describe("translateAuthError", () => {
  it("maps invalid credentials to the i18n key", () => {
    expect(translateAuthError(t, "Invalid login credentials")).toBe("t:auth.errors.invalidCredentials");
  });

  it("maps unconfirmed email to the i18n key", () => {
    expect(translateAuthError(t, "Email not confirmed")).toBe("t:auth.errors.emailNotConfirmed");
  });

  it("maps already-registered to the i18n key", () => {
    expect(translateAuthError(t, "User already registered")).toBe("t:auth.errors.userExists");
  });

  it("maps GoTrue invalid-email message (with quoted address) to the i18n key", () => {
    expect(translateAuthError(t, 'Email address "x@example.com" is invalid')).toBe("t:auth.errors.invalidEmail");
  });

  it("maps rate-limit variants to the i18n key", () => {
    expect(translateAuthError(t, "email rate limit exceeded")).toBe("t:auth.errors.rateLimited");
    expect(translateAuthError(t, "Too many requests")).toBe("t:auth.errors.rateLimited");
  });

  it("maps server-side short-password message to the existing passwordMin key", () => {
    expect(translateAuthError(t, "Password should be at least 6 characters")).toBe("t:auth.passwordMin");
  });

  it("passes through unknown messages unchanged", () => {
    expect(translateAuthError(t, "Some novel backend error")).toBe("Some novel backend error");
  });

  it("falls back to the generic key for empty messages", () => {
    expect(translateAuthError(t, "")).toBe("t:auth.errors.generic");
    expect(translateAuthError(t, null)).toBe("t:auth.errors.generic");
    expect(translateAuthError(t, undefined)).toBe("t:auth.errors.generic");
  });
});
