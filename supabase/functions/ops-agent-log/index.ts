// ops-agent-log: least-privilege endpoint that records ONE ops-agent run outcome into
// ops_agent_runs, so the daily digest can report the agent's activity. Called by the
// ops-investigate GitHub workflow after each run. Auth reuses HW_HEALTH_SECRET (already shared
// between the workflow and Supabase env) — this endpoint can do exactly one thing: insert a run
// row. No new owner secret needed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-health-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ctEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  const SECRET = Deno.env.get("HW_HEALTH_SECRET") || "";
  const provided = req.headers.get("x-health-secret") || "";
  if (!SECRET || !provided || !ctEq(provided, SECRET)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const outcome_type = ["pr", "issue", "none"].includes(body?.outcome_type) ? body.outcome_type : "none";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("ops_agent_runs").insert({
      run_id: String(body?.run_id ?? "").slice(0, 40) || null,
      problem: String(body?.problem ?? "").slice(0, 2000) || null,
      outcome_type,
      outcome_ref: String(body?.outcome_ref ?? "").slice(0, 20) || null,
      note: String(body?.note ?? "").slice(0, 500) || null,
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
