// teacher-room — pg_cron (`teacher-room-morning` 09:00/09:20 Tashkent, `teacher-room-evening` 21:00/21:20) calls this
// through ops_net_post with {"kind":"morning"|"evening"}. Posts the curators' greeting / thank-you + statistics in
// «KURATORLAR 6.0». Logic: room.ts; words: texts.ts.
//
// Auth: like support-reminder — no config.toml entry (an entry would redeploy every function, including the live bot);
// the gateway's verify_jwt=true takes the cron's Bearer cron_service_key(), then the body requires x-internal-secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import { type Kind, runOnce } from "./room.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  const kind: Kind | null = body?.kind === "morning" || body?.kind === "evening" ? body.kind : null;
  if (!kind) return json({ error: "kind must be morning or evening" }, 400);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

  try {
    const out = await runOnce({
      admin,
      now: () => Date.now(),
      send: async (method, payload) => {
        const { outcome, result } = await sendTelegramResult(botToken, method, payload, {
          admin, purpose: `teacher_room_${kind}`, recipientId: (payload.chat_id as number) ?? null,
        });
        return { ok: outcome.ok, result, error: outcome.error };
      },
    }, kind);
    return json(out, 200);
  } catch (e) {
    await logHealth(admin, "teacher_room_post_failed", { kind, status: "crashed", error: redactSecrets(e).slice(0, 500) },
      { source: "teacher-room" });
    return json({ status: "crashed" }, 500);
  }
});
