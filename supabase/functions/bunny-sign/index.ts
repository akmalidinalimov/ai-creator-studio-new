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

function bytesToBase64Url(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(raw: string) {
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToBase64Url(new Uint8Array(hashBuf));
}

async function sha256Of(raw: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return new Uint8Array(buf);
}

function bytesToHex(bytes: Uint8Array) {
  let h = "";
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, "0");
  return h;
}

async function hmacSha256Base64Url(key: string, msg: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function computeVariants(KEY: string, token_path: string, expires: number, video_guid: string) {
  const variants: { variant: string; token: string }[] = [];

  variants.push({ variant: "sha256_concat", token: await sha256Base64Url(`${KEY}${token_path}${expires}`) });
  variants.push({ variant: "sha256_concat_iponly", token: await sha256Base64Url(`${KEY}${token_path}${expires}`) });
  variants.push({ variant: "sha256_reverse", token: await sha256Base64Url(`${token_path}${expires}${KEY}`) });
  variants.push({ variant: "sha256_path_first", token: await sha256Base64Url(`${KEY}${expires}${token_path}`) });
  variants.push({ variant: "hmac_sha256_path_expires", token: await hmacSha256Base64Url(KEY, `${token_path}${expires}`) });
  variants.push({ variant: "hmac_sha256_expires_path", token: await hmacSha256Base64Url(KEY, `${expires}${token_path}`) });
  variants.push({ variant: "hmac_sha256_path_only", token: await hmacSha256Base64Url(KEY, token_path) });

  // sha256 -> hex -> base64url
  const hexBytes = bytesToHex(await sha256Of(`${KEY}${token_path}${expires}`));
  variants.push({ variant: "sha256_hex", token: bytesToBase64Url(new TextEncoder().encode(hexBytes)) });

  variants.push({ variant: "sha256_encoded_path", token: await sha256Base64Url(`${KEY}${encodeURIComponent(token_path)}${expires}`) });
  variants.push({ variant: "sha256_with_playlist", token: await sha256Base64Url(`${KEY}${token_path}playlist.m3u8${expires}`) });

  // bonus: try with full path including playlist.m3u8 (no trailing slash on token_path)
  const fullPath = `${token_path}${video_guid ? "" : ""}playlist.m3u8`;
  variants.push({ variant: "sha256_fullpath_playlist", token: await sha256Base64Url(`${KEY}${fullPath}${expires}`) });

  return variants;
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
    if (body?.mode === "verify") {
      const { data: isAdmin, error: roleErr } = await userClient.rpc("has_role", {
        _user_id: userData.user.id,
        _role: "admin",
      });

      if (roleErr || isAdmin !== true) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token_path = String(body?.token_path || "");
      const expires = Number(body?.expires);
      const expected_token = String(body?.expected_token || "");
      if (!token_path.startsWith("/") || !token_path.endsWith("/") || !Number.isInteger(expires) || !expected_token) {
        return new Response(JSON.stringify({ error: "invalid token_path, expires, or expected_token" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const raw = `${KEY}${token_path}${expires}`;
      const video_guid = String(body?.video_guid || "").trim();
      const variants = await computeVariants(KEY, token_path, expires, video_guid);

      const candidates = variants.map((v) => ({
        variant: v.variant,
        token_preview: `${v.token.slice(0, 8)}...${v.token.slice(-8)}`,
        matches: v.token === expected_token,
      }));
      const matchedVariant = variants.find((v) => v.token === expected_token);

      return new Response(
        JSON.stringify({
          match: {
            variant: matchedVariant?.variant ?? null,
            computed_token_preview: matchedVariant
              ? `${matchedVariant.token.slice(0, 8)}...${matchedVariant.token.slice(-8)}`
              : null,
          },
          candidates,
          expected_token_preview: `${expected_token.slice(0, 8)}...${expected_token.slice(-8)}`,
          secret_length: KEY?.length ?? 0,
          secret_first_chars: KEY?.slice(0, 2) ?? "",
          secret_last_chars: KEY?.slice(-2) ?? "",
          raw_length: raw.length,
          hostname: HOSTNAME,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
    const token = await sha256Base64Url(raw);
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
              hash_b64_preview: token.slice(0, 16),
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
