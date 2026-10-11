// question-assistant — pg_cron (`question-assistant`, every minute, ONLY while a question is waiting or an incident is
// open) calls this through ops_net_post. Logic: assistant.ts; words: texts.ts.
//
// Auth: like support-agent — no config.toml entry (an entry would redeploy every function, including the live bot);
// the gateway's verify_jwt=true takes the cron's Bearer cron_service_key(), then the body requires x-internal-secret.
// AI: the OpenAI key the support agent already uses (labels only). With no key every question goes to the curator
// (question_assist.error = 'no_provider').

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import type { Provider } from "../_shared/ai-label.ts";
import { PROMPT_VERSION, runOnce } from "./assistant.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const openaiKey = Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY") || "";
  const available: Provider[] = openaiKey ? ["openai"] : [];

  try {
    const out = await runOnce({
      admin,
      now: () => Date.now(),
      available,
      label: { openaiKey, fetchFn: fetch, now: () => Date.now() },
      send: async (method, payload) => {
        const { outcome, result } = await sendTelegramResult(botToken, method, payload, {
          admin, purpose: `question_assistant_${method}`, recipientId: (payload.chat_id as number) ?? null,
        });
        return { ok: outcome.ok, result, error: outcome.error };
      },
    });
    return json(out, 200);
  } catch (e) {
    await logHealth(admin, "question_assistant_run", { status: "crashed", error: redactSecrets(e).slice(0, 500), prompt_version: PROMPT_VERSION },
      { source: "question-assistant" });
    return json({ status: "crashed" }, 500);
  }
});
