// question-triage — pg_cron (`question-triage`, every minute, only while untriaged questions exist) calls this through
// ops_net_post. Decides for each new «KURATORGA SAVOLLAR» message whether it needs a teacher (triage.ts; migration
// 20261016112600). Shadow mode records the verdict; live mode hides a confident non-question ('dismissed').
//
// Auth: like question-assistant — no config.toml entry; the gateway's verify_jwt=true takes the cron's Bearer
// cron_service_key(), then the body requires x-internal-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import type { Provider } from "../_shared/ai-label.ts";
import { PROMPT_VERSION, runOnce } from "./triage.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const openaiKey = Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY") || "";
  const available: Provider[] = openaiKey ? ["openai"] : [];

  try {
    const out = await runOnce({ admin, now: () => Date.now(), available, label: { openaiKey, fetchFn: fetch, now: () => Date.now() } });
    return json(out, 200);
  } catch (e) {
    await logHealth(admin, "question_triage_failed", { status: "crashed", error: redactSecrets(e).slice(0, 500), prompt: PROMPT_VERSION },
      { source: "question-triage" });
    return json({ status: "crashed" }, 500);
  }
});
