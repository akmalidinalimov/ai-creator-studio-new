// challenge-qa-judge — pg_cron (`challenge-qa-judge`, 6-59/10) calls this through ops_net_post.
//
// Labels queued Challenge 6.0 "peer answer" candidates with an AI model and records each verdict through
// SQL RPCs. It never decides or pays points (challenge_qa_apply does, in SQL), never writes a table except
// through RPCs and logHealth, and never talks to Telegram. Logic lives in judge.ts (unit-tested in CI).
//
// Auth: no config.toml entry on purpose — the gateway default verify_jwt=true, and the cron sends
// `Authorization: Bearer cron_service_key()` like canary / detect-and-nudge / notify-badge-award. Adding an
// entry would redeploy every function, including the live bot. The body then requires x-internal-secret.
//
// Providers: ANTHROPIC_API_KEY (Claude Haiku 4.5) first when set, else OpenAI (the existing key). With no
// key at all the queue waits, loudly: a daily challenge_qa_no_provider row, a no_key heartbeat, and the
// SQL watchdog's backlog alarm.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { type AnthropicErrorClasses, type AnthropicLike, PROMPT_VERSION, runOnce } from "./judge.ts";

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
      },
      {
        admin,
        makeAnthropic: (apiKey: string) =>
          new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) as unknown as AnthropicLike,
        anthropicErrors: ANTHROPIC_ERRORS,
        fetchFn: fetch,
        now: () => Date.now(),
      },
    );
    return json(out.body, out.httpStatus);
  } catch (e) {
    // Anything unexpected is still a DB-visible run row, never a console-only failure.
    await logHealth(admin, "challenge_qa_judge_run", {
      status: "crashed", error: redactSecrets(e).slice(0, 500), prompt_version: PROMPT_VERSION,
    });
    return json({ status: "crashed" }, 500);
  }
});
