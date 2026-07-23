// tg-broadcast: the Telegram MINI APP entry point. The /tg/broadcast page runs inside Telegram with
// no Supabase session — Telegram instead hands it a cryptographically signed `initData` string. We
// validate that signature server-side (HMAC-SHA256 with the bot token, Telegram's standard), map the
// telegram_id to an admin profile, then delegate to the shared createBroadcast(). Same reliability
// and safety as the web path (kill-switch, quiet-hours, honest reporting) via _shared/broadcast-core.
//
// Actions (POST body): { action:'init'|'send'|'status', initData, ... }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { broadcastStatus, coursesWithReach, createBroadcast } from "../_shared/broadcast-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Constant-time hex compare for the signature check.
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Validate Telegram Mini App initData. secret = HMAC_SHA256(key="WebAppData", msg=bot_token);
// hash = HMAC_SHA256(key=secret, msg=data_check_string). Also enforce a 1h freshness window.
async function validateInitData(initData: string): Promise<{ ok: boolean; userId?: number }> {
  if (!initData || !BOT_TOKEN) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash");
  params.delete("signature"); // Telegram 7.0+ adds this for its Ed25519 path; excluded from the HMAC check.
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(BOT_TOKEN)));
  const sk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!ctEq(hex, hash)) return { ok: false };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 3600) return { ok: false };
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return { ok: true, userId: Number(user?.id) || undefined };
  } catch {
    return { ok: false };
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const { ok, userId } = await validateInitData(String(body?.initData || ""));
  if (!ok || !userId) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Map the Telegram user to an admin profile.
  const { data: prof } = await admin.from("profiles").select("id").eq("telegram_id", userId).maybeSingle();
  if (!prof?.id) return json({ error: "forbidden" }, 403);
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", prof.id).in("role", ["admin", "superadmin"]);
  if (!roles?.length) return json({ error: "forbidden" }, 403);

  const action = body?.action;

  if (action === "init") {
    return json({ courses: await coursesWithReach(admin) });
  }

  if (action === "status") {
    const id = String(body?.broadcast_id || "");
    if (!id) return json({ error: "broadcast_id required" }, 400);
    return json(await broadcastStatus(admin, id));
  }

  if (action === "send") {
    let image_path: string | null = null;
    if (body?.image_b64) {
      const ext = String(body?.image_ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
      const key = `${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await admin.storage.from("broadcast-images")
        .upload(key, b64ToBytes(String(body.image_b64)), { contentType: `image/${ext === "jpg" ? "jpeg" : ext}` });
      if (upErr) return json({ error: `image upload failed: ${upErr.message}` }, 500);
      image_path = key;
    }
    const { status, body: out } = await createBroadcast(admin, {
      course_id: String(body?.course_id || ""),
      image_path,
      body_uz: String(body?.body_uz || ""),
      body_ru: body?.body_ru ? String(body.body_ru) : null,
      body_en: body?.body_en ? String(body.body_en) : null,
      button_label: body?.button_label ? String(body.button_label).slice(0, 64) : null,
      button_url: body?.button_url ? String(body.button_url).slice(0, 512) : null,
      mode: body?.mode === "all" ? "all" : "test",
      actor_uid: prof.id,
    });
    return json(out, status);
  }

  return json({ error: "unknown_action" }, 400);
});
