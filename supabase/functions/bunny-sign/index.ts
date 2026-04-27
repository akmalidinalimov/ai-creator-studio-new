// Signs a Bunny Stream HLS playlist URL with token-auth (IP-bound, 30 min TTL).
// POST body: { library_id: string, video_guid: string }
// Response 200: { signed_url, expires }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip") || "0.0.0.0";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const HOSTNAME = Deno.env.get("BUNNY_HLS_HOSTNAME") || "";
    const KEY = Deno.env.get("BUNNY_TOKEN_AUTH_KEY") || "";

    // Auth: require valid JWT
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!HOSTNAME || !KEY) {
      return new Response(
        JSON.stringify({ error: "Bunny secrets not configured (BUNNY_HLS_HOSTNAME, BUNNY_TOKEN_AUTH_KEY)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => null);
    const library_id = String(body?.library_id || "").trim();
    const video_guid = String(body?.video_guid || "").trim();
    const guidRe = /^[a-f0-9-]{8,}$/i;
    if (!library_id || !/^\d+$/.test(library_id) || !video_guid || !guidRe.test(video_guid)) {
      return new Response(JSON.stringify({ error: "invalid library_id or video_guid" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ip = clientIp(req);
    const tokenPath = `/${video_guid}/`; // directory, trailing slash — covers playlist + .ts segments
    const expires = Math.floor(Date.now() / 1000) + 1800;
    const raw = `${KEY}${tokenPath}${expires}${ip}`;
    const hash = await sha256(raw);
    const token = base64url(hash);

    const signed_url = `https://${HOSTNAME}/${video_guid}/playlist.m3u8?token=${token}&token_path=${encodeURIComponent(tokenPath)}&expires=${expires}`;
    return new Response(JSON.stringify({ signed_url, expires }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bunny-sign error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
