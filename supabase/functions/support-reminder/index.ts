// support-reminder — pg_cron (`support-reminder`, every 10 min, ONLY while an open ticket is due) calls this through
// ops_net_post. Re-sends every unanswered «❓ Yordam» ticket to the admins every hour. Logic: reminder.ts.
//
// Auth: like support-agent — no config.toml entry (an entry would redeploy every function, including the live bot);
// the gateway's verify_jwt=true takes the cron's Bearer cron_service_key(), then the body requires x-internal-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import { runOnce } from "./reminder.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

  try {
    const out = await runOnce({
      admin,
      now: () => Date.now(),
      send: async (method, payload) => {
        const { outcome, result } = await sendTelegramResult(botToken, method, payload, {
          admin, purpose: `support_reminder_${method}`, recipientId: (payload.chat_id as number) ?? null,
        });
        return { ok: outcome.ok, result, error: outcome.error };
      },
    });
    return json(out, 200);
  } catch (e) {
    await logHealth(admin, "support_reminder_run", { status: "crashed", error: redactSecrets(e).slice(0, 500) },
      { source: "support-reminder" });
    return json({ status: "crashed" }, 500);
  }
});
