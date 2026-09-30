// admin-merge-duplicates × Daily Tasks (PR-5, spec G24 / §10.6). Every daily-task row of a student (submissions, the
// message ledger, Instagram posts, streak awards, the DM outbox, Mini App claims) references profiles(id) ON DELETE
// CASCADE, so deleting a duplicate profile would silently delete its task work and points. Before the merge deletes
// a duplicate, challenge_task_reassign_user(_from, _to) (PR-3, service_role) moves all of it to the canonical student
// (two live submissions for one task: the earlier keeps the slot, the later becomes 'merged'; both re-settled).
//
// Contract for the caller: ok=false -> KEEP the duplicate (do not delete it); the failure is DB-visible
// ('challenge_task_reassign_failed'). A missing RPC (the engine not applied) is today's behaviour: nothing to move.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type ReassignResult =
  | { ok: true; submissions: number; merged: number; skipped?: "rpc_missing" }
  | { ok: false; reason: string };

export async function reassignDailyTasks(admin: Db, fromId: string, toId: string): Promise<ReassignResult> {
  let data: Record<string, unknown> | null = null;
  let error: { code?: string; message?: string } | null = null;
  try {
    const res = await admin.rpc("challenge_task_reassign_user", { _from: fromId, _to: toId });
    data = res?.data ?? null;
    error = res?.error ?? null;
  } catch (e) {
    error = { code: "threw", message: String(e) };
  }
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(String(error.message ?? ""));
    if (missing) {
      await logHealthOnce(admin, "challenge_task_reassign_rpc_missing", "rpc_missing", { from: fromId, to: toId },
        { source: "admin-merge-duplicates" });
      return { ok: true, submissions: 0, merged: 0, skipped: "rpc_missing" };
    }
    const reason = `rpc_error: ${String(error.code ?? "error").slice(0, 20)}`;
    await logHealth(admin, "challenge_task_reassign_failed", {
      from: fromId, to: toId, reason, error: String(error.message ?? "").slice(0, 300),
    }, { source: "admin-merge-duplicates", targetUserId: toId });
    return { ok: false, reason };
  }
  if (data?.ok !== true) {
    const reason = String(data?.reason ?? "unknown");
    await logHealth(admin, "challenge_task_reassign_failed", { from: fromId, to: toId, reason }, {
      source: "admin-merge-duplicates", targetUserId: toId,
    });
    return { ok: false, reason };
  }
  return { ok: true, submissions: Number(data.submissions) || 0, merged: Number(data.merged) || 0 };
}
