// warmup-dispatch — drains warmup.events → plugins → applier. HTTP wrapper; the loop is run.ts.
//
// Cron-invoked, x-internal-secret gated, matching broadcast-drainer so a Vault rotation covers
// this function too.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/edge.ts";
import { registerPlugins } from "../_warmup/bus.ts";
import { PLUGINS } from "./plugins.ts";
import { runDispatch } from "./run.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

registerPlugins(PLUGINS);

let __sec: string | null = null;
let __lastFetch = 0;
async function internalSecret(force = false): Promise<string> {
  const now = Date.now();
  // Debounce the forced re-fetch to ≤1 RPC / 15s — this endpoint is verify_jwt=false, so the
  // amplification has to stay bounded.
  if (__sec && (!force || now - __lastFetch < 15_000)) return __sec;
  __lastFetch = now;
  const { data, error } = await admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const presented = req.headers.get("x-internal-secret");
  let expected = await internalSecret();
  if (!presented || presented !== expected) expected = await internalSecret(true);
  if (!presented || presented !== expected) return json({ error: "forbidden" }, 403);

  const result = await runDispatch(admin);
  return json(result, result.ok ? 200 : 500);
});
