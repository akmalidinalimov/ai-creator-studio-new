// support-agent — pg_cron (`support-agent`, every minute, ONLY while support_agent.enabled and a diagnosis is waiting)
// calls this through ops_net_post.
//
// Diagnoses claimed «❓ Yordam» tickets and sends each admin ONE proposal card (root cause, proposed fix, drafted reply,
// ✅/❌ buttons). It never changes a student's data: the bot's sa: buttons call support_apply_fix(), the only write
// path. Logic lives in agent.ts (unit-tested in CI).
//
// Auth: like challenge-qa-judge — no config.toml entry (an entry would redeploy every function, including the live
// bot); the gateway's verify_jwt=true takes the cron's `Authorization: Bearer cron_service_key()`, then the body
// requires x-internal-secret.
//
// Providers: ANTHROPIC_API_KEY (Claude Haiku 4.5) first when set, else OpenAI. With no key at all the agent still
// works deterministically (rule pick + template reply); the diagnosis row records llm.skipped = 'no_provider'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import type { AnthropicErrorClasses, AnthropicLike } from "../_shared/ai-label.ts";
import { PROMPT_VERSION, runOnce } from "./agent.ts";

const ANTHROPIC_ERRORS: AnthropicErrorClasses = {
  APIError: Anthropic.APIError,
  AuthenticationError: Anthropic.AuthenticationError,
  PermissionDeniedError: Anthropic.PermissionDeniedError,
  RateLimitError: Anthropic.RateLimitError,
  APIConnectionError: Anthropic.APIConnectionError,
  APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError,
  APIUserAbortError: Anthropic.APIUserAbortError,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

  try {
    const out = await runOnce(
      {
        anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        openaiKey: Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY") || "",
      },
      {
        admin,
        makeAnthropic: (apiKey: string) =>
          new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) as unknown as AnthropicLike,
        anthropicErrors: ANTHROPIC_ERRORS,
        fetchFn: fetch,
        now: () => Date.now(),
        send: async (method, payload) => {
          const { outcome, result } = await sendTelegramResult(botToken, method, payload, {
            admin, purpose: "support_agent_card", recipientId: (payload.chat_id as number) ?? null,
          });
          return { ok: outcome.ok, result, error: outcome.error };
        },
      },
    );
    return json(out.body, out.httpStatus);
  } catch (e) {
    // Anything unexpected is still a DB-visible row, never a console-only failure. Leases expire in 5 min.
    await logHealth(admin, "support_agent_run", {
      status: "crashed", error: redactSecrets(e).slice(0, 500), prompt_version: PROMPT_VERSION,
    }, { source: "support-agent" });
    return json({ status: "crashed" }, 500);
  }
});
