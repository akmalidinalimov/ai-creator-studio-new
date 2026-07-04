import type { TFunction } from "i18next";

const MATCHERS: Array<{ test: (m: string) => boolean; key: string }> = [
  { test: (m) => m.includes("invalid login credentials"), key: "auth.errors.invalidCredentials" },
  { test: (m) => m.includes("email not confirmed"), key: "auth.errors.emailNotConfirmed" },
  { test: (m) => m.includes("already registered"), key: "auth.errors.userExists" },
  { test: (m) => m.includes("email address") && m.includes("is invalid"), key: "auth.errors.invalidEmail" },
  { test: (m) => m.includes("rate limit") || m.includes("too many requests"), key: "auth.errors.rateLimited" },
  { test: (m) => m.includes("password should be at least"), key: "auth.passwordMin" },
];

export function translateAuthError(t: TFunction, message: string | null | undefined): string {
  const m = (message || "").toLowerCase();
  const hit = MATCHERS.find((x) => x.test(m));
  if (hit) return t(hit.key);
  return message || t("auth.errors.generic");
}
