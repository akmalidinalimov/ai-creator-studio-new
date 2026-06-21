// Central role resolution — the single source of truth for "what can this user do".
//
// The DB (user_roles) stores granular roles INCLUDING "superadmin"; the app routes
// and UI on three effective roles. Keeping the precedence in ONE place stops the
// route guard, the admin sidebar, and AuthContext from drifting.
//
// Bug this fixes (M13): AuthContext previously mapped only admin/teacher/student, so
// a "superadmin"-only user fell through to "student" and was bounced out of /admin/*.

export type AppRole = "admin" | "teacher" | "student";

const SUPERADMIN = "superadmin";

/**
 * Collapse the set of granular DB roles to the app's effective role.
 * superadmin is treated as admin (superadmin >= admin).
 */
export function resolveRole(dbRoles: readonly string[] | null | undefined): AppRole | null {
  if (!dbRoles || dbRoles.length === 0) return null;
  if (dbRoles.includes("admin") || dbRoles.includes(SUPERADMIN)) return "admin";
  if (dbRoles.includes("teacher")) return "teacher";
  return "student";
}

/** True if the user holds the superadmin role (preserved separately because
 *  resolveRole collapses it into "admin"). Used to gate admin-creation UI. */
export function hasSuperadmin(dbRoles: readonly string[] | null | undefined): boolean {
  return !!dbRoles && dbRoles.includes(SUPERADMIN);
}

/** Effective-role predicates — use these instead of inline `role === "..."` checks
 *  so the route guard and the sidebar can never disagree. */
export const isAdmin = (role: AppRole | null): boolean => role === "admin";
export const isStaff = (role: AppRole | null): boolean => role === "admin" || role === "teacher";
