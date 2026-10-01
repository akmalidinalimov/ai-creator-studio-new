// frontend-deploy-watchdog — is the LIVE website (www.aicreator.academy, also the Telegram Mini App) on the newest
// main? pg_cron 'frontend-deploy-watchdog' (every 15 min at :07/:22/:37/:52, migration 20261001030000) calls this
// through ops_net_post. It reads main's newest commits and their "Vercel" commit status from the GitHub REST API with
// the Vault OPS_GITHUB_PAT, and DMs the admins when the production frontend build failed or stalled.
//
// Why it exists: on 2026-09-30 preview builds of agent branches used up Vercel's Hobby quota (100 deployments/day),
// the production builds of #241–#244 failed with "Deployment rate limited", and the site froze at afe750e while
// Supabase moved on. The only trace was a red commit status. Root fix: vercel.json git.deploymentEnabled (main only).
// This is the detector for the whole class: quota, build error, a deploy that never starts or never finishes.
//
// Logic: watch.ts (pure decisions + message text), github.ts (REST reads), run.ts (one run, deps injected). Unit-
// tested in CI (watch.test.ts, github.test.ts, run.test.ts), including a replay of the 2026-09-30 sequence.
//
// Signals (admin_actions): frontend_deploy_failed / frontend_deploy_stalled (one per incident, deduped per sha),
// frontend_deploy_recovered (only after an alarm), frontend_deploy_watch_no_pat / _forbidden / _api_error / _crashed
// (once per Tashkent day each — graceful is not silent), frontend_deploy_watch_caller_forbidden (a wrong internal
// secret), '<row>_dm_undelivered' (once a day while a DM reaches no admin; it is re-sent every 30 min until one does)
// and '<row>_dm_delivered_late', frontend_deploy_watch_recipients_failed (the admin lookup itself failed).
// Liveness: app_settings 'frontend_deploy_watchdog_state'.checked_at on every run.
//
// Auth: no config.toml entry on purpose (adding one redeploys every function, the live bot included) — the gateway
// default verify_jwt=true accepts the cron's `Authorization: Bearer cron_service_key()`, exactly like canary-15min;
// the body then requires x-internal-secret (rotation-safe verifyInternalSecret).
// Inert: with no OPS_GITHUB_PAT in Vault it records 'frontend_deploy_watch_no_pat' once a day, stamps the state and
// does nothing else. Kill-switch: select cron.unschedule('frontend-deploy-watchdog');

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { adminTelegramIds } from "../_shared/admin-recipients.ts";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth, logHealthOnce } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { runWatch } from "./run.ts";
import { STATE_KEY } from "./watch.ts";

const SOURCE = "frontend-deploy-watchdog";
const DEDUPE_WINDOW_MS = 7 * 86_400_000;
const MAX_ADMINS = 3; // same recipients as challenge_tasks_admin_dm(): up to 3 admins / superadmins with a telegram_id

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) {
    await logHealthOnce(admin, "frontend_deploy_watch_caller_forbidden", "forbidden", {}, { source: SOURCE });
    return json({ error: "forbidden" }, 403);
  }

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  try {
    const out = await runWatch({
      now: () => Date.now(),
      fetchFn: fetch,
      async getPat() {
        const { data, error } = await admin.rpc("ops_github_pat");
        if (error) return { pat: null, error: redactSecrets(error.message).slice(0, 160) };
        return { pat: typeof data === "string" && data.trim() ? data.trim() : null, error: null };
      },
      async readState() {
        const { data, error } = await admin.from("app_settings").select("value").eq("key", STATE_KEY).maybeSingle();
        if (error) throw new Error(error.message);
        return data?.value ?? null;
      },
      async writeState(s) {
        const { error } = await admin.from("app_settings").upsert({ key: STATE_KEY, value: s }, { onConflict: "key" });
        if (error) console.error(`${SOURCE}: state write failed`, error.message);
        return !error;
      },
      async alreadyLogged(action, sha) {
        const { data, error } = await admin.from("admin_actions").select("id")
          .eq("action", action)
          .eq("details->>sha", sha)
          .gte("created_at", new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString())
          .limit(1);
        if (error) return false; // a failed check must not swallow an alarm: a duplicate beats silence
        return Array.isArray(data) && data.length > 0;
      },
      log: (action, details) => logHealth(admin, action, details, { source: SOURCE }),
      logOnce: (action, key, details) => logHealthOnce(admin, action, key, details, { source: SOURCE }),
      async adminChatIds() {
        // Two queries, never a profiles→user_roles embed (no FK: PGRST200 on every call — see admin-recipients.ts).
        const r = await adminTelegramIds(admin, { limit: MAX_ADMINS });
        if (r.error) {
          await logHealthOnce(admin, "frontend_deploy_watch_recipients_failed", "recipients", {
            error: redactSecrets(r.error).slice(0, 200),
          }, { source: SOURCE });
        }
        return r.ids; // [] → the DM stays pending and '<row>_dm_undelivered' is written (run.ts)
      },
      async send(chatId, text) {
        if (!botToken) return false; // the alarm's admin_actions row carries dm_sent: 0
        const outcome = await sendTelegram(
          botToken,
          "sendMessage",
          { chat_id: chatId, text, disable_web_page_preview: true },
          { admin, purpose: "frontend_deploy_watchdog", recipientId: chatId },
        );
        return outcome.ok;
      },
    });
    return json(out);
  } catch (e) {
    // runWatch does not throw by construction; this is the last line, still DB-visible.
    await logHealth(admin, "frontend_deploy_watch_crashed", { error: redactSecrets(e).slice(0, 300) }, { source: SOURCE });
    return json({ status: "crashed" }, 500);
  }
});
