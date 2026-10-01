// The weekly approval (Daily Tasks PR-9), web side: the ?week= deep link from the bot's «👀 Ko‘rib chiqish» button and
// the answer of public.challenge_tasks_approve_week (migration 20260930200010). Pure, unit-tested.
//
// PAST DAYS: the week button approves drafts dated TODAY or later only (the RPC enforces it; past drafts come back in
// skipped_past). A past day was never posted (PR-5 never posts a past date), and approving it after the fact would be a
// miss in every student's streak -- a deliberate retro day is the day drawer's own path (source «retro» + the post link).
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

/** A week's drafts split at today (Tashkent, YYYY-MM-DD): `open` the button can approve, `past` it never will. */
export function weekDraftCounts(list: ReadonlyArray<{ status: string; task_date: string }>, today: string): { open: number; past: number } {
  let open = 0, past = 0;
  for (const t of list) {
    if (t.status !== "draft") continue;
    if (t.task_date < today) past++;
    else open++;
  }
  return { open, past };
}

export type WeekApproveFailure = { task_id?: number; date?: string; title?: string; error?: string };
export type WeekApproveSkip = { task_id?: number; date?: string; title?: string; reason?: string };
export type WeekApproveResult = {
  approved: number;
  alreadyApproved: number;
  draftsLeft: number;
  failed: WeekApproveFailure[];
  skippedPast: WeekApproveSkip[];
  pastWeek: boolean;
};

/** A defensive read of the RPC's jsonb (never throws; junk -> null). */
export function parseApproveResult(raw: unknown): WeekApproveResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) return null;
  const failed = Array.isArray(o.failed)
    ? (o.failed as unknown[]).filter((f): f is WeekApproveFailure => !!f && typeof f === "object")
    : [];
  const skippedPast = Array.isArray(o.skipped_past)
    ? (o.skipped_past as unknown[]).filter((f): f is WeekApproveSkip => !!f && typeof f === "object")
    : [];
  return {
    approved: Number(o.approved) || 0,
    alreadyApproved: Number(o.already_approved) || 0,
    draftsLeft: Number(o.drafts_left) || 0,
    failed,
    skippedPast,
    pastWeek: o.past_week === true,
  };
}

/** The toast after an approval, in the admin's words. */
export function approveSummary(r: WeekApproveResult): string {
  const past = r.skippedPast.length;
  const pastNote = past > 0 ? `, ${past} ta o‘tgan kun tasdiqlanmadi` : "";
  if (r.approved === 0 && r.failed.length === 0) {
    if (r.pastWeek) return "Bu hafta o‘tib ketdi — o‘tgan kunlar bu tugma bilan tasdiqlanmaydi";
    if (past > 0) return `O‘tgan kunlar (${past} ta) bu tugma bilan tasdiqlanmaydi — kerak bo‘lsa, kunni alohida (retro) tasdiqlang`;
    return `Bu hafta allaqachon tasdiqlangan (${r.alreadyApproved} ta vazifa)`;
  }
  if (r.failed.length > 0) return `${r.approved} ta tasdiqlandi, ${r.failed.length} ta tasdiqlanmadi${pastNote} — sababi pastda`;
  return `${r.approved} ta vazifa tasdiqlandi${pastNote}`;
}

/** The RPC's refusals, in the admin's words (the SQL raises Uzbek messages for the ones an admin can meet). */
export function approveErrorMessage(raw: string | null | undefined): string {
  const m = raw ?? "";
  if (/Faqat admin|not allowed|permission denied/i.test(m)) return "Ruxsat yo‘q (faqat admin)";
  return m || "Tasdiqlab bo‘lmadi";
}
