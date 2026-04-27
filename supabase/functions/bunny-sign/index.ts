// Signs a Bunny Stream HLS playlist URL with token-auth (30 min TTL).
// POST body: { library_id: string, video_guid: string }
// Response 200: { signed_url, expires }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

    const tokenPath = `/${video_guid}/`;
    const expires = Math.floor(Date.now() / 1000) + 1800;
    const raw = `${KEY}${tokenPath}${expires}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
    const token = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const encodedTokenPath = encodeURIComponent(tokenPath);

    const signed_url = `https://${HOSTNAME}/bcdn_token=${token}&expires=${expires}&token_path=${encodedTokenPath}/${video_guid}/playlist.m3u8`;
    console.log(JSON.stringify({ tokenPath, expires, hostname: HOSTNAME, signed_url }));

    const wantsDebug = body?.debug === true;
    if (wantsDebug) {
      const { data: isAdmin } = await userClient.rpc("has_role", {
        _user_id: userData.user.id,
        _role: "admin",
      });

      if (isAdmin === true) {
        return new Response(
          JSON.stringify({
            signed_url,
            expires,
            debug: {
              tokenPath,
              encodedTokenPath,
              raw_hash_input_preview: `${raw.slice(0, 8)}...${raw.slice(-8)}`,
              hash_b64_preview: b64.slice(0, 16),
            },
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

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
