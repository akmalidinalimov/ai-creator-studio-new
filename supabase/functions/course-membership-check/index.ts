// course-membership-check — pg_cron (`course-membership-check`, every 15 min, only while a membership course is
// published) calls this through ops_net_post. Logic: check.ts; state + lock rule: migration 20261030145000.
//
// Auth: like group-room — no config.toml entry; the gateway's verify_jwt=true takes the cron's Bearer
// cron_service_key(), then the body requires x-internal-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import { runOnce, verdictOf } from "./check.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (!botToken) return json({ error: "bot not configured" }, 500);

  try {
    const out = await runOnce({
      admin,
      now: () => Date.now(),
      // getChatMember through the shared Telegram client (token containment); record:false — a "left" answer or a
      // failed probe is not a failed SEND, so nothing goes to telegram_send_failed (the run's heartbeat counts them)
      probe: async (chatId, telegramId) => {
        try {
          const { outcome, result } = await sendTelegramResult(botToken, "getChatMember",
            { chat_id: chatId, user_id: telegramId }, { record: false });
          return verdictOf({ ok: outcome.ok, result, error_code: outcome.status });
        } catch (_e) {
          return "error";
        }
      },
      send: async (chatId, text, button) => {
        const { outcome } = await sendTelegramResult(botToken, "sendMessage", {
          chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
          ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
        }, { admin, purpose: "course_membership_warning", recipientId: chatId });
        return outcome.ok;
      },
    });
    return json(out, 200);
  } catch (e) {
    await logHealth(admin, "course_membership_check_failed", { status: "crashed", error: redactSecrets(e).slice(0, 500) },
      { source: "course-membership-check" });
    return json({ status: "crashed" }, 500);
  }
});
