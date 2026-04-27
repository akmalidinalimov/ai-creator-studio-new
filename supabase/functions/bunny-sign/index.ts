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

async function hmacSha256Base64UrlBytes(keyBytes: Uint8Array, msgBytes: Uint8Array) {
  const k = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, msgBytes);
  return bytesToBase64Url(new Uint8Array(sig));
}

async function hmacSha256Base64Url(key: string, msg: string) {
  return hmacSha256Base64UrlBytes(new TextEncoder().encode(key), new TextEncoder().encode(msg));
}

function hexDecode(s: string): Uint8Array {
  const clean = s.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

async function sha256Base64UrlBytes(bytes: Uint8Array) {
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(hashBuf));
}

function concatBytes(...arrs: Uint8Array[]) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
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

  // ----- Additional variants (12-19) -----
  const enc = new TextEncoder();
  const keyHexBytes = hexDecode(KEY);
  const tpBytes = enc.encode(token_path);
  const expBytes = enc.encode(String(expires));
  const spaceBytes = enc.encode(" ");

  variants.push({
    variant: "sha256_concat_hexbytes",
    token: await sha256Base64UrlBytes(concatBytes(keyHexBytes, tpBytes, expBytes)),
  });
  variants.push({
    variant: "hmac_sha256_hexbytes_path_exp",
    token: await hmacSha256Base64UrlBytes(keyHexBytes, concatBytes(tpBytes, expBytes)),
  });
  variants.push({
    variant: "hmac_sha256_hexbytes_pe_join",
    token: await hmacSha256Base64UrlBytes(keyHexBytes, concatBytes(tpBytes, spaceBytes, expBytes)),
  });
  variants.push({
    variant: "hmac_sha256_string_pe_join",
    token: await hmacSha256Base64Url(KEY, `${token_path} ${expires}`),
  });
  variants.push({
    variant: "sha256_concat_no_slash",
    token: await sha256Base64Url(`${KEY}${token_path.slice(1, -1)}${expires}`),
  });
  variants.push({
    variant: "sha256_concat_video_guid_only",
    token: await sha256Base64Url(`${KEY}${video_guid}${expires}`),
  });
  variants.push({
    variant: "sha256_concat_with_paramname",
    token: await sha256Base64Url(`${KEY}bcdn_token${token_path}${expires}`),
  });
  variants.push({
    variant: "hmac_sha256_path_exp_secret_in_msg",
    token: await hmacSha256Base64Url(KEY, `${KEY}${token_path}${expires}`),
  });

  // ----- Additional variants (14-21) -----
  variants.push({
    variant: "hmac_sha256_string_path_exp_lowercase",
    token: await hmacSha256Base64Url(KEY.toLowerCase(), `${token_path}${expires}`),
  });
  variants.push({
    variant: "sha256_concat_with_dashes_removed",
    token: await sha256Base64Url(`${KEY.replace(/-/g, "")}${token_path}${expires}`),
  });
  variants.push({
    variant: "sha256_concat_uppercase_token",
    token: await sha256Base64Url(`${KEY.toUpperCase()}${token_path}${expires}`),
  });
  variants.push({
    variant: "hmac_sha256_path_exp_basic",
    token: await hmacSha256Base64Url(KEY, `${token_path}${expires}`),
  });
  variants.push({
    variant: "sha256_concat_with_uri_path",
    token: await sha256Base64Url(`${KEY}${encodeURIComponent(token_path).toUpperCase()}${expires}`),
  });

  // 19. sha256 double
  const firstHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${KEY}${token_path}${expires}`));
  variants.push({
    variant: "sha256_double",
    token: await sha256Base64UrlBytes(new Uint8Array(firstHash)),
  });

  // 20. md5 -> base64url (Web Crypto has no MD5; implement minimal MD5)
  const md5Hex = md5Hex_(`${KEY}${token_path}${expires}`);
  const md5Bytes = new Uint8Array(md5Hex.length / 2);
  for (let i = 0; i < md5Bytes.length; i++) md5Bytes[i] = parseInt(md5Hex.substr(i * 2, 2), 16);
  variants.push({ variant: "md5_concat", token: bytesToBase64Url(md5Bytes) });

  // 21. sha256 -> standard base64 (with + / and = padding)
  const stdHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${KEY}${token_path}${expires}`));
  let s = ""; const stdBytes = new Uint8Array(stdHashBuf);
  for (let i = 0; i < stdBytes.length; i++) s += String.fromCharCode(stdBytes[i]);
  variants.push({ variant: "base64_standard", token: btoa(s) });

  return variants;
}

// Minimal MD5 implementation (returns hex)
function md5Hex_(s: string): string {
  function toUtf8(str: string) {
    return new TextEncoder().encode(str);
  }
  const msg = toUtf8(s);
  const len = msg.length;
  const withOne = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  withOne.set(msg);
  withOne[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 8, bitLen >>> 0, true);
  dv.setUint32(withOne.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const K = [
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
  ];
  const r = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21,
  ];
  const lr = (x:number,n:number) => ((x<<n)|(x>>>(32-n)))>>>0;

  for (let off = 0; off < withOne.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i*4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7*i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B; B = (B + lr(F, r[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const toHexLE = (n:number) => {
    let h = "";
    for (let i = 0; i < 4; i++) h += ((n >>> (i*8)) & 0xff).toString(16).padStart(2,"0");
    return h;
  };
  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
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
          secret_hex_byte_count: hexDecode(KEY).length,
          raw_length: raw.length,
          raw_length_string_mode: (KEY + token_path + expires).length,
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
