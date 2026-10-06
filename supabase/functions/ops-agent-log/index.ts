// ops-agent-log: least-privilege endpoint that records ONE ops-agent run outcome into
// ops_agent_runs, so the daily digest can report the agent's activity. Called by the
// ops-investigate GitHub workflow after each run. Auth reuses HW_HEALTH_SECRET (already shared
// between the workflow and Supabase env) — this endpoint can do exactly one thing: insert a run
// row. No new owner secret needed.
//
// 2026-10-06 (support auto-resolver plan, PR0): when the run opened a PR (outcome_type 'pr', outcome_ref = the PR
// number) and that PR was never logged before, the admins also get the approve card (_shared/ops-card.ts:
// ops:a:<pr> / ops:reject:<pr>, handled admin-only by the bot). Before this, nothing told the owner an ops-agent PR
// existed. Card outcome is DB-visible: ops_pr_card_sent / ops_pr_card_failed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { logHealth } from "../_shared/edge.ts";
import { opsPrCardText, opsPrNumber, sendOpsCard } from "../_shared/ops-card.ts";
import { shouldSendPrCard } from "./decide.ts";

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
    const outcome_ref = String(body?.outcome_ref ?? "").slice(0, 20) || null;
    const problem = String(body?.problem ?? "").slice(0, 2000) || null;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Was this PR already logged (an earlier run that found the same open PR)? Read BEFORE inserting this run.
    const pr = outcome_type === "pr" ? opsPrNumber(outcome_ref) : null;
    let priorLogged: number | null = 0;
    if (pr) {
      const { count, error } = await admin.from("ops_agent_runs")
        .select("id", { count: "exact", head: true }).eq("outcome_type", "pr").eq("outcome_ref", String(pr));
      priorLogged = error ? null : (count ?? 0);
    }

    await admin.from("ops_agent_runs").insert({
      run_id: String(body?.run_id ?? "").slice(0, 40) || null,
      problem,
      outcome_type,
      outcome_ref,
      note: String(body?.note ?? "").slice(0, 500) || null,
    });

    let card: Record<string, unknown> | null = null;
    if (shouldSendPrCard(outcome_type, pr, priorLogged)) {
      const { data: tokRow } = await admin.from("platform_settings").select("value").eq("key", "telegram").maybeSingle();
      const botToken = (tokRow?.value as any)?.bot_token;
      const res = botToken
        ? await sendOpsCard(admin, String(botToken), opsPrCardText(pr!, problem), pr, "ops_pr_card")
        : { sent: 0, recipients: 0, error: "bot not configured" };
      card = { pr, ...res };
      await logHealth(admin, res.sent > 0 ? "ops_pr_card_sent" : "ops_pr_card_failed", card, { source: "ops-agent-log" });
    }

    return new Response(JSON.stringify({ ok: true, card }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
