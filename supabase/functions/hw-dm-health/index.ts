// hw-dm-health: read-only health endpoint for the OUT-OF-BAND morning verifier.
// Called daily by a GitHub Actions workflow (08:25 Tashkent) with x-health-secret —
// a dedicated secret that can do nothing but read these counts. Returns queue/cron
// health so an external system can assert the 08:00 teacher-DM flush actually happened.
// Unreachable or erroring == the workflow fails == the owner gets emailed. By design.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-health-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Constant-time compare (same pattern as staff-intake / sheet-sync).
const ctEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const SECRET = Deno.env.get("HW_HEALTH_SECRET") || "";
  const provided = req.headers.get("x-health-secret") || "";
  if (!SECRET || !provided || !ctEq(provided, SECRET)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await admin.rpc("hw_dm_health_stats");
    if (error) throw error;
    // Also surface recent genuine platform errors so the out-of-band verifier AND the ops agent
    // (whose only DB window is this endpoint) can see + classify them. Best-effort: never let a
    // missing errors summary fail the core health check.
    let recent_errors: unknown = null;
    try {
      const { data: errs } = await admin.rpc("recent_platform_errors", { _hours: 24 });
      recent_errors = errs ?? null;
    } catch (_e) { /* keep health working even if the errors summary fails */ }
    return new Response(JSON.stringify({ ...(data as Record<string, unknown>), recent_errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
