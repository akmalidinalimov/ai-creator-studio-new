// challenge-tasks-worker — pg_cron's challenge_tasks_tick() (every minute, migration 20260930152010) calls this
// through ops_net_post ONLY when challenge_tasks is active and challenge_tasks_worker_due() says a claim would lease
// something (a post, a receipt, a due DM, an identity-sweep sender). challenge_task_identity_sweep_request() (PR-8's
// go-live pre-step) calls it with {mode: 'identity_sweep', since, until}. While the feature is paused nothing calls it.
//
// It posts the daily task and the 20:00 summary, sends the receipts the bot did not, sends the DM outbox and runs the
// identity sweep — every decision is the SQL engine's (claims / records, PR-3); this only renders and sends.
// Logic: worker.ts (run), render.ts (post button, summary, DMs), registrar.ts (the sweep's registrar); receipts
// render through the bot's _shared/daily-task-render.ts. Unit-tested in CI (worker.test.ts, render.test.ts) and
// end to end against the real SQL on PGlite (_challenge/testing/daily-tasks-worker-check.ts).
//
// Auth: no config.toml entry on purpose — the gateway default verify_jwt=true, and the tick sends
// `Authorization: Bearer cron_service_key()` like challenge-task-check / challenge-qa-judge. Adding an entry would
// redeploy every function, including the live bot. The body then requires x-internal-secret (rotation-safe).
// Env: TELEGRAM_BOT_TOKEN (sends), TELEGRAM_BOT_USERNAME (the t.me/<bot>?start= buttons), SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY (the admin-create-students engine for the registrar).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth, logHealthOnce } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramWithResult } from "../_shared/telegram-send.ts";
import { runWorker } from "./worker.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  if (!(await verifyInternalSecret(req, admin))) {
    // A rotated / wrong secret must not fail silently: one row a day (the watchdog's backlog alarms fire meanwhile).
    await logHealthOnce(admin, "challenge_task_worker_forbidden", "forbidden", {}, { source: "challenge-tasks-worker" });
    return json({ error: "forbidden" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  try {
    const out = await runWorker(
      { botToken, botUsername: Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "", supabaseUrl, serviceKey },
      {
        admin,
        send: (method, payload, opts) => sendTelegramWithResult(botToken, method, payload, opts),
        fetchFn: fetch,
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      (body && typeof body === "object") ? body : {},
    );
    return json(out.body, out.httpStatus);
  } catch (e) {
    // Anything unexpected is still a DB-visible run row (the watchdog's 'worker_errors' alarm reads it).
    await logHealth(admin, "challenge_task_worker_run", { status: "crashed", error: redactSecrets(e).slice(0, 500) }, {
      source: "challenge-tasks-worker",
    });
    return json({ status: "crashed" }, 500);
  }
});
