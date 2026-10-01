// admin-merge-duplicates × Daily Tasks: the duplicate's task work is moved BEFORE the delete; a failed move keeps the
// duplicate and is DB-visible; a missing RPC is today's behaviour. No network, no permissions.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reassignDailyTasks } from "./daily-tasks.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function admin(answer: { data?: unknown; error?: unknown }) {
  const calls: Row[] = [];
  const inserts: Row[] = [];
  return {
    calls, inserts,
    rpc: (name: string, args: Row) => { calls.push({ name, args }); return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }); },
    from: (_t: string) => {
      const b: Row = {
        select: () => b, eq: () => b, gte: () => b, limit: () => b,
        insert: (row: Row) => { inserts.push(row); return Promise.resolve({ data: null, error: null }); },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  };
}

Deno.test("reassign: calls challenge_task_reassign_user(_from, _to) and reports what moved", async () => {
  const a = admin({ data: { ok: true, submissions: 3, merged: 1 } });
  assertEquals(await reassignDailyTasks(a, "dup", "canon"), { ok: true, submissions: 3, merged: 1 });
  assertEquals(a.calls, [{ name: "challenge_task_reassign_user", args: { _from: "dup", _to: "canon" } }]);
  assertEquals(a.inserts.length, 0);
});

Deno.test("reassign: an engine refusal or an RPC error → ok:false (the caller KEEPS the duplicate), DB-visible", async () => {
  const a = admin({ data: { ok: false, reason: "no_profile" } });
  assertEquals(await reassignDailyTasks(a, "dup", "canon"), { ok: false, reason: "no_profile" });
  assertEquals(a.inserts[0].action, "challenge_task_reassign_failed");
  const b = admin({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
  assertEquals(await reassignDailyTasks(b, "dup", "canon"), { ok: false, reason: "rpc_error: 57014" });
  assertEquals(b.inserts[0].details.reason, "rpc_error: 57014");
});

Deno.test("reassign: the RPC missing (the engine not applied) is today's behaviour — nothing to move, one signal", async () => {
  const a = admin({ error: { code: "PGRST202", message: "Could not find the function" } });
  assertEquals(await reassignDailyTasks(a, "dup", "canon"), { ok: true, submissions: 0, merged: 0, skipped: "rpc_missing" });
  assertEquals(a.inserts[0].action, "challenge_task_reassign_rpc_missing");
});
