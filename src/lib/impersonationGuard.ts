// Side-effect import: monkey-patches the shared supabase client so that while
// localStorage.getItem('impersonating') is truthy, write paths are blocked.
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Exported for the Vitest case that pins the daily-task writes (spec G12).
export const WRITE_RPCS = new Set([
  "admin_change_role",
  "track_video_progress",
  "recalc_leaderboard",
  "admin-change-role",
  // Kunlik vazifalar (Daily Tasks PR-7, G12): a student's one-tap corrections, the DM-permission stamp and the admin
  // override. lib/dailyTasks.ts gates each on impersonatingReadonly() first; this is the second layer. (The
  // submit-daily-task edge call is gated there too — functions.invoke is not patched here.)
  "my_challenge_task_move",
  "my_challenge_task_withdraw",
  "my_challenge_task_restore",
  "my_telegram_write_access_granted",
  "admin_challenge_task_override",
  "challenge_tasks_approve_week", // Daily Tasks PR-9: approves a whole week of tasks
]);

const isImpersonating = () => {
  try {
    return typeof window !== "undefined" && !!window.localStorage?.getItem("impersonating");
  } catch {
    return false;
  }
};

const blocked = () => {
  toast.error("Read-only (impersonation mode)");
  return Promise.reject(new Error("read-only impersonation"));
};

const WRITE_OPS = ["insert", "update", "upsert", "delete"] as const;

const origFrom = supabase.from.bind(supabase);
(supabase as any).from = (table: any) => {
  const builder: any = origFrom(table);
  for (const op of WRITE_OPS) {
    const fn = builder[op];
    if (typeof fn === "function") {
      builder[op] = (...args: any[]) => {
        if (isImpersonating()) return blocked();
        return fn.apply(builder, args);
      };
    }
  }
  return builder;
};

const origRpc = supabase.rpc.bind(supabase);
(supabase as any).rpc = (name: string, ...args: any[]) => {
  if (isImpersonating() && WRITE_RPCS.has(name)) return blocked();
  return (origRpc as any)(name, ...args);
};

export {};
