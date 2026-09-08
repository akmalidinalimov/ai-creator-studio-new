// warmup-drainer — drains warmup.outbox → _shared/telegram-send.ts. HTTP wrapper; loop is run.ts.
//
// The only place the warm-up bot talks to Telegram, and therefore where both safety mechanisms are
// enforced: the kill switch (checked before a row is claimed) and the governor (quiet hours defer,
// budgets drop, replies are pull, reactions are unlimited).
//
// Cron-invoked, x-internal-secret gated.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/edge.ts";
import { WARMUP_BOT_TOKEN } from "../_warmup/tg.ts";
import { runDrainer } from "./run.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

let __sec: string | null = null;
let __lastFetch = 0;
async function internalSecret(force = false): Promise<string> {
  const now = Date.now();
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

  if (!WARMUP_BOT_TOKEN) return json({ ok: false, error: "bot_not_configured" }, 503);

  const result = await runDrainer(admin);
  return json(result, result.ok ? 200 : 500);
});
