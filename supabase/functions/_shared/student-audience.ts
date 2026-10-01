// student-audience — who a STUDENT reminder may go to. One rule for every sender that picks its recipients by
// scanning profiles (cron-engagement's daily / streak / drip, detect-and-nudge, weekly-digest, student-of-week,
// re-engagement-send).
//
// WHY: those scans filter on profile columns only (status, telegram_id, notifications_enabled, ...), and a
// teacher's profile passes every one of them. In the 30 days to 2026-09-30, 5 teacher-only accounts received 91
// daily reminders, 8 streak warnings and 1 inactivity message (notifications_log), plus an inactive_3d and a
// module_complete nudge (nudge_log) — noise that teaches teachers to ignore bot messages.
//
// THE RULE: a STAFF-ONLY account (a teacher / admin / superadmin role and NO student role) gets no student
// reminder. An account that also holds the student role is a student and keeps getting them (the owner's own
// admin+student test account, a teacher enrolled as a student). An account with no role row at all is not
// staff, so it is unaffected (every eligible profile has a role today; the rule does not depend on it).
//
// FAIL-OPEN, NOT SILENT: when the role read fails, loadStaffOnlyIds returns ids:null and every caller sends
// exactly as it did before this filter existed (a teacher getting one extra reminder is harmless; students
// missing theirs is not). The failure is DB-visible: a 'student_audience_read_failed' admin_actions row (once
// per sender per Tashkent day), and cron-engagement also lists it in engagement_run_done.prefetch_failed, which
// engagement_run_watchdog already alarms on.
import { logHealthOnce } from "./edge.ts";

export const STAFF_ROLES = ["teacher", "admin", "superadmin"] as const;
const STAFF: ReadonlySet<string> = new Set<string>(STAFF_ROLES);

/** A staff role and no student role. Pure. */
export function isStaffOnly(roles: readonly (string | null | undefined)[]): boolean {
  let staff = false;
  for (const r of roles) {
    if (r === "student") return false;
    if (typeof r === "string" && STAFF.has(r)) staff = true;
  }
  return staff;
}

export type RoleRow = { user_id: string; role: string };

/** The staff-only user ids in a set of user_roles rows (every role of each user must be in the rows). Pure. */
export function staffOnlyIdsFromRows(rows: readonly RoleRow[]): Set<string> {
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    if (!r?.user_id) continue;
    const list = byUser.get(r.user_id);
    if (list) list.push(r.role);
    else byUser.set(r.user_id, [r.role]);
  }
  const out = new Set<string>();
  for (const [id, roles] of byUser) if (isStaffOnly(roles)) out.add(id);
  return out;
}

export type StaffOnly = { ids: Set<string> | null; error: string | null };

/**
 * The staff-only user ids, in two small reads (both bounded by the number of staff, ~10 today): the staff role
 * rows, then which of those users ALSO hold the student role. Never throws. `ids: null` = the read failed →
 * do not filter (see the header); the failure is recorded once per `fn` per day.
 */
// deno-lint-ignore no-explicit-any
export async function loadStaffOnlyIds(admin: any, fn: string): Promise<StaffOnly> {
  let error: string | null = null;
  try {
    const staff = await admin.from("user_roles").select("user_id, role").in("role", [...STAFF_ROLES]);
    if (staff.error) {
      error = String(staff.error.message ?? staff.error);
    } else {
      const rows = (staff.data ?? []) as RoleRow[];
      const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
      if (!ids.length) return { ids: new Set(), error: null };
      const stu = await admin.from("user_roles").select("user_id, role").eq("role", "student").in("user_id", ids);
      if (stu.error) {
        error = String(stu.error.message ?? stu.error);
      } else {
        return { ids: staffOnlyIdsFromRows([...rows, ...((stu.data ?? []) as RoleRow[])]), error: null };
      }
    }
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  const msg = (error || "unknown").slice(0, 300);
  console.error(`[${fn}] staff-role read failed — student reminders are NOT filtered this run`, msg);
  await logHealthOnce(admin, "student_audience_read_failed", fn, { fn, error: msg }, { source: fn });
  return { ids: null, error: msg };
}

/** True when `userId` must not get a student reminder. A failed read (ids null) filters nobody. */
export function skipStaffOnly(s: StaffOnly | null | undefined, userId: string | null | undefined): boolean {
  return !!(s?.ids && userId && s.ids.has(userId));
}
