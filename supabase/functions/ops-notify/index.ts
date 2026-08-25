// ops-notify: least-privilege Telegram notifier for the autonomous-ops pipeline (Phase 2).
// Called by GitHub Actions (deploy failures now; agent analyses in Phase 3) with a dedicated
// secret that can do exactly one thing: DM the platform admins. Follows the hw-dm-health shape:
// its own secret, constant-time compare, nothing else reachable.
//
// Auth: x-ops-notify-secret header, compared against the Vault secret OPS_NOTIFY_SECRET via the
// service-role RPC ops_notify_secret() — the owner inserts the value once in the SQL editor
// (select vault.create_secret('<value>','OPS_NOTIFY_SECRET','ops notify auth')); until then the
// RPC returns NULL and every caller gets 403 (gracefully dormant).
//
// Body: { text: string, pr?: number } — when pr is present, the message carries the approve
// keyboard (ops:a:<pr> / ops:reject:<pr>, handled admin-only by the bot webhook) + a PR link.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ops-notify-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REPO_URL = "https://github.com/akmalidinalimov/ai-creator-studio-new";

const ctEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: secret } = await admin.rpc("ops_notify_secret");
    const provided = req.headers.get("x-ops-notify-secret") || "";
    if (!secret || !provided || !ctEq(provided, String(secret))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const text = String(body?.text || "").slice(0, 3500);
    const pr = Number.isInteger(body?.pr) && body.pr > 0 && body.pr < 1_000_000 ? Number(body.pr) : null;
    if (!text) {
      return new Response(JSON.stringify({ error: "text required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: tokRow } = await admin.from("platform_settings").select("value").eq("key", "telegram").maybeSingle();
    const botToken = (tokRow?.value as any)?.bot_token;
    if (!botToken) {
      return new Response(JSON.stringify({ error: "bot not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Recipients: platform admins with a linked Telegram (same rule as platform_anomaly_digest).
    const { data: roles } = await admin.from("user_roles").select("user_id").in("role", ["admin", "superadmin"] as any);
    const ids = Array.from(new Set((roles || []).map((r: any) => r.user_id)));
    const { data: profs } = ids.length
      ? await admin.from("profiles").select("id, telegram_id").in("id", ids).not("telegram_id", "is", null).limit(3)
      : { data: [] as any[] };

    const reply_markup = pr
      ? {
        inline_keyboard: [
          [{ text: "✅ Ko'rib tasdiqlash", callback_data: `ops:a:${pr}` },
           { text: "❌ Rad etish", callback_data: `ops:reject:${pr}` }],
          [{ text: `🔍 PR #${pr} ni ochish`, url: `${REPO_URL}/pull/${pr}` }],
        ],
      }
      : undefined;

    let sent = 0;
    for (const p of (profs || []) as any[]) {
      // sendTelegram never throws (transport error → transient outcome) and records any
      // non-delivery of this ops DM to admin_actions by construction (record defaults true).
      const out = await sendTelegram(
        botToken,
        "sendMessage",
        {
          chat_id: Number(p.telegram_id),
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(reply_markup ? { reply_markup } : {}),
        },
        { admin, purpose: "ops_notify", recipientId: p.telegram_id },
      );
      if (out.ok) sent++;
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
