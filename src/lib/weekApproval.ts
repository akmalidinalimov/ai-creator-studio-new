// The weekly approval (Daily Tasks PR-9), web side: the ?week= deep link from the bot's «👀 Ko‘rib chiqish» button and
// the answer of public.challenge_tasks_approve_week (migration 20260930200000). Pure, unit-tested.
import { addDays, isIsoDate, isoWeekday } from "@/lib/dailyTasksPlan";

/** The Monday of the week a `?week=YYYY-MM-DD` link names (any day of it is accepted), or null. */
export function weekFromSearch(search: string | null | undefined): string | null {
  let w: string | null = null;
  try {
    w = new URLSearchParams(search ?? "").get("week");
  } catch {
    return null;
  }
  return isIsoDate(w) ? mondayOf(w) : null;
}

export function mondayOf(iso: string): string {
  return addDays(iso, -(isoWeekday(iso) - 1));
}

export type WeekApproveFailure = { task_id?: number; date?: string; title?: string; error?: string };
export type WeekApproveResult = {
  approved: number;
  alreadyApproved: number;
  draftsLeft: number;
  failed: WeekApproveFailure[];
};

/** A defensive read of the RPC's jsonb (never throws; junk -> null). */
export function parseApproveResult(raw: unknown): WeekApproveResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) return null;
  const failed = Array.isArray(o.failed)
    ? (o.failed as unknown[]).filter((f): f is WeekApproveFailure => !!f && typeof f === "object")
    : [];
  return {
    approved: Number(o.approved) || 0,
    alreadyApproved: Number(o.already_approved) || 0,
    draftsLeft: Number(o.drafts_left) || 0,
    failed,
  };
}

/** The toast after an approval, in the admin's words. */
export function approveSummary(r: WeekApproveResult): string {
  if (r.approved === 0 && r.failed.length === 0) return `Bu hafta allaqachon tasdiqlangan (${r.alreadyApproved} ta vazifa)`;
  if (r.failed.length > 0) return `${r.approved} ta tasdiqlandi, ${r.failed.length} ta tasdiqlanmadi — sababi pastda`;
  return `${r.approved} ta vazifa tasdiqlandi`;
}

/** The RPC's refusals, in the admin's words (the SQL raises Uzbek messages for the ones an admin can meet). */
export function approveErrorMessage(raw: string | null | undefined): string {
  const m = raw ?? "";
  if (/Faqat admin|not allowed|permission denied/i.test(m)) return "Ruxsat yo‘q (faqat admin)";
  return m || "Tasdiqlab bo‘lmadi";
}
