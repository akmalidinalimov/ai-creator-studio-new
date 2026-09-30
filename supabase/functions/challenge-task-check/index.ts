// challenge-task-check — pg_cron (`challenge-task-check-kick`, every minute) calls this through ops_net_post, and
// ONLY when platform_settings.challenge_tasks is active, ai = true and a 'checking' submission is due
// (challenge_task_check_kick(), migration 20260930151010). While the feature is paused it is never called.
//
// Labels leased Daily Tasks submissions with an AI model and records each verdict through SQL RPCs. It never
// decides or pays points (challenge_task_check_record does, in SQL), never writes a table except through RPCs and
// logHealth, and never SENDS to Telegram (it only retrieves the submitted files; receipts / DMs are the worker's
// job). Logic lives in check.ts / media.ts / verdict.ts and _shared/ai-label.ts (unit-tested in CI).
//
// Auth: no config.toml entry on purpose — the gateway default verify_jwt=true, and the kick sends
// `Authorization: Bearer cron_service_key()` like challenge-qa-judge / canary / notify-badge-award. Adding an entry
// would redeploy every function, including the live bot. The body then requires x-internal-secret.
//
// Providers: ANTHROPIC_API_KEY (claude-haiku-4-5) first when set, else OpenAI (gpt-5-mini, the existing key). With
// no key at all the queue waits, loudly (a daily challenge_task_check_no_provider row, an hourly no_key heartbeat,
// and the engine watchdog's checks_stuck alarm). TELEGRAM_BOT_TOKEN fetches the files.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import type { AnthropicErrorClasses, AnthropicLike } from "../_shared/ai-label.ts";
import { runOnce } from "./check.ts";
import { imagescriptCodec } from "./image.ts";
import { PROMPT_VERSION } from "./verdict.ts";

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

  try {
    const out = await runOnce(
      {
        anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        openaiKey: Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY") || "",
        botToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
      },
      {
        admin,
        makeAnthropic: (apiKey: string) =>
          new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 }) as unknown as AnthropicLike,
        anthropicErrors: ANTHROPIC_ERRORS,
        fetchFn: fetch,
        now: () => Date.now(),
        codec: imagescriptCodec,
      },
    );
    return json(out.body, out.httpStatus);
  } catch (e) {
    // Anything unexpected is still a DB-visible run row, never a console-only failure. Leases expire in 10 min.
    await logHealth(admin, "challenge_task_check_run", {
      status: "crashed", error: redactSecrets(e).slice(0, 500), prompt_version: PROMPT_VERSION,
    });
    return json({ status: "crashed" }, 500);
  }
});
