// claude-agent: task-queue API for the owner's laptop Claude Code poller (2026-08-04, PR1).
// The poller holds a scoped CLAUDE_AGENT_SECRET (NOT the Supabase service key) and calls this with
// x-claude-agent-secret. Every call refreshes the laptop heartbeat (so the bot knows on/off).
// Actions: 'heartbeat' (liveness), 'claim' (atomically take the oldest queued task), 'report'
// (mark a task done/error + DM the owner the result). Kill-switch: platform_settings key
// 'claude_agent' → {"enabled": false}. Same least-privilege shape as hw-dm-health.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-claude-agent-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Constant-time compare (same pattern as hw-dm-health / staff-intake).
const ctEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

async function botToken(admin: any): Promise<string> {
  const { data } = await admin.from("platform_settings").select("value").eq("key", "telegram").maybeSingle();
  return (data?.value?.bot_token as string) || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SECRET = Deno.env.get("CLAUDE_AGENT_SECRET") || "";
  const provided = req.headers.get("x-claude-agent-secret") || "";
  if (!SECRET || !provided || !ctEq(provided, SECRET)) return json({ error: "forbidden" }, 403);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");
    const host = String(body?.host || "laptop").slice(0, 64);

    // Every call is a heartbeat — the laptop is demonstrably alive right now.
    await admin.from("platform_settings").upsert(
      { key: "claude_agent_heartbeat", value: { at: new Date().toISOString(), host } },
      { onConflict: "key" },
    );

    const { data: cfg } = await admin.from("platform_settings").select("value").eq("key", "claude_agent").maybeSingle();
    const enabled = (cfg?.value?.enabled ?? true) !== false; // default ON

    if (action === "heartbeat") return json({ ok: true, enabled });

    if (action === "claim") {
      if (!enabled) return json({ task: null, enabled: false });
      const { data: next } = await admin.from("claude_code_tasks")
        .select("id").eq("status", "queued").order("created_at", { ascending: true }).limit(1).maybeSingle();
      if (!next?.id) return json({ task: null });
      // Optimistic atomic claim: the .eq('status','queued') on UPDATE means only one poller wins.
      const { data: claimed } = await admin.from("claude_code_tasks")
        .update({ status: "running", started_at: new Date().toISOString(), host })
        .eq("id", next.id).eq("status", "queued")
        .select("id, prompt, requested_tg").maybeSingle();
      return json({ task: claimed ?? null });
    }

    if (action === "report") {
      const id = String(body?.id || "");
      if (!id) return json({ error: "id required" }, 400);
      const status = body?.status === "error" ? "error" : "done";
      const { data: task } = await admin.from("claude_code_tasks")
        .update({
          status,
          result: body?.result ? String(body.result).slice(0, 8000) : null,
          error: body?.error ? String(body.error).slice(0, 3000) : null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", id).select("requested_tg, prompt").maybeSingle();

      // DM the requester the outcome. PLAIN TEXT (no parse_mode) so code/diff output full of <, >, &
      // can never trigger a Telegram 400, and hard-capped under the 4096-char limit. Delivery is
      // checked and a failure emits a DB-visible signal (the task itself already shows done/error).
      if (task?.requested_tg) {
        const tok = await botToken(admin);
        if (tok) {
          const head = status === "error" ? "❌ Claude Code — xatolik" : "✅ Claude Code — bajarildi";
          const promptLine = task.prompt ? `\n📌 ${String(task.prompt).slice(0, 200)}` : "";
          const bodyOut = (status === "error" ? String(body?.error || "") : String(body?.result || "")) || "—";
          const textMsg = `${head}${promptLine}\n\n${bodyOut}`.slice(0, 3900);
          // sendTelegram never throws and records any non-delivery to admin_actions (record defaults
          // true). PLAIN TEXT preserved (no parse_mode) so code/diff output can't trigger a 400.
          const send = await sendTelegram(
            tok,
            "sendMessage",
            { chat_id: task.requested_tg, text: textMsg, disable_web_page_preview: true },
            { admin, purpose: "claude_agent", recipientId: task.requested_tg },
          );
          if (!send.ok) {
            // Keep the function's own delivery-status recording too (a detector may query it).
            try {
              await admin.from("platform_error_log").insert({
                source: "claude-agent", action: "report_dm_failed",
                message: String(send.error || "").slice(0, 200), telegram_id: task.requested_tg, context: { task_id: id },
              });
            } catch (_e) { /* logging is best-effort */ }
          }
        }
      }
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
