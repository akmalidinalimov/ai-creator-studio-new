// Side-effect import: monkey-patches the shared supabase client so that while
// localStorage.getItem('impersonating') is truthy, write paths are blocked.
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const WRITE_RPCS = new Set([
  "admin_change_role",
  "track_video_progress",
  "recalc_leaderboard",
  "admin-change-role",
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
