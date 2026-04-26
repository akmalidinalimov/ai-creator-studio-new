// Telegram Login Widget callback. Verifies HMAC, links to existing profile by telegram_username,
// then issues a magic link and redirects the user to it (signing them in).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createHash, createHmac } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type TgPayload = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

function verify(payload: TgPayload, botToken: string): boolean {
  const { hash, ...fields } = payload;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${(fields as any)[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return computed === hash;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const payload = (await req.json()) as { tg: TgPayload; redirectTo?: string };
    const tg = payload.tg;
    if (!tg?.hash || !tg?.auth_date || !tg?.id) {
      return new Response(JSON.stringify({ error: "Invalid Telegram payload" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Reject if older than 24h
    const ageSec = Math.floor(Date.now() / 1000) - Number(tg.auth_date);
    if (ageSec > 86400) {
      return new Response(JSON.stringify({ error: "Telegram auth expired, please try again" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Read bot token from platform_settings
    const { data: setting } = await admin.from("platform_settings").select("value").eq("key", "telegram").maybeSingle();
    const botToken = (setting?.value as any)?.bot_token as string | undefined;
    if (!botToken) {
      return new Response(JSON.stringify({ error: "Telegram bot is not configured. Ask your admin." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!verify(tg, botToken)) {
      return new Response(JSON.stringify({ error: "Invalid Telegram signature" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Find profile by telegram_id first, then by username
    let profile: any = null;
    {
      const { data } = await admin.from("profiles").select("id, email, telegram_username").eq("telegram_id", tg.id).maybeSingle();
      profile = data;
    }
    if (!profile && tg.username) {
      const { data } = await admin.from("profiles").select("id, email, telegram_username").ilike("telegram_username", tg.username).maybeSingle();
      profile = data;
    }
    if (!profile) {
      return new Response(JSON.stringify({ error: `No account linked to @${tg.username || tg.id}. Ask your admin to add you.` }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Save telegram_id on first link
    if (!profile.telegram_id) {
      await admin.from("profiles").update({ telegram_id: tg.id, telegram_username: tg.username || profile.telegram_username }).eq("id", profile.id);
    }

    // Generate magic link
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: { redirectTo: payload.redirectTo || `${new URL(req.url).origin}/dashboard` },
    });
    if (linkErr) {
      return new Response(JSON.stringify({ error: linkErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, url: linkData.properties?.action_link }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
