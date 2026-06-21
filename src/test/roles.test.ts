import { describe, it, expect } from "vitest";
import { resolveRole, hasSuperadmin, isAdmin, isStaff } from "@/lib/roles";

describe("resolveRole", () => {
  it("returns null when the user has no roles", () => {
    expect(resolveRole([])).toBeNull();
    expect(resolveRole(null)).toBeNull();
    expect(resolveRole(undefined)).toBeNull();
  });

  it("maps the three base roles", () => {
    expect(resolveRole(["admin"])).toBe("admin");
    expect(resolveRole(["teacher"])).toBe("teacher");
    expect(resolveRole(["student"])).toBe("student");
  });

  it("treats a superadmin-only user as admin (the M13 lockout fix)", () => {
    expect(resolveRole(["superadmin"])).toBe("admin");
  });

  it("applies admin > teacher > student precedence", () => {
    expect(resolveRole(["student", "teacher", "admin"])).toBe("admin");
    expect(resolveRole(["student", "teacher"])).toBe("teacher");
  });
});

describe("hasSuperadmin", () => {
  it("detects superadmin even alongside other roles", () => {
    expect(hasSuperadmin(["superadmin", "teacher"])).toBe(true);
  });
  it("is false for non-superadmins", () => {
    expect(hasSuperadmin(["admin"])).toBe(false);
    expect(hasSuperadmin([])).toBe(false);
  });
});

// Guard parity — pins that EVERY assignable role resolves to an effective role AND
// passes the matching route-guard predicate. RequireAuth grants admin-only access
// iff isAdmin(role) and staff-only access iff isStaff(role); these must never drift
// from resolveRole (the cause of the superadmin lockout).
describe("route-guard parity", () => {
  const cases: Array<{ dbRoles: string[]; adminArea: boolean; staffArea: boolean }> = [
    { dbRoles: ["admin"], adminArea: true, staffArea: true },
    { dbRoles: ["superadmin"], adminArea: true, staffArea: true },
    { dbRoles: ["teacher"], adminArea: false, staffArea: true },
    { dbRoles: ["student"], adminArea: false, staffArea: false },
  ];

  it("resolver and guard predicates agree for every assignable role", () => {
    for (const { dbRoles, adminArea, staffArea } of cases) {
      const role = resolveRole(dbRoles);
      expect(isAdmin(role)).toBe(adminArea);
      expect(isStaff(role)).toBe(staffArea);
    }
  });
});
