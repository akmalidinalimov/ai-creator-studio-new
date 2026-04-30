// Initialize a direct browser->Bunny Stream TUS upload.
// Admin-only. Creates a Bunny video record and returns TUS auth headers
// so the browser can upload the file directly to video.bunnycdn.com.
//
// POST body: { lesson_id: string, filename: string, filesize?: number }
// Response 200: { videoId, libraryId, authorization_signature, authorization_expire }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function bytesToHex(bytes: Uint8Array) {
  let h = "";
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, "0");
  return h;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const BUNNY_LIBRARY_ID = Deno.env.get("BUNNY_LIBRARY_ID") || "";
  const BUNNY_API_KEY = Deno.env.get("BUNNY_API_KEY") || "";

  if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Bunny is not configured (missing BUNNY_LIBRARY_ID or BUNNY_API_KEY)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Verify caller is an admin (validate JWT via service-role client)
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const lessonId = String(body?.lesson_id || "").trim();
  const filename = String(body?.filename || "").trim() || "video.mp4";
  if (!lessonId) {
    return new Response(JSON.stringify({ error: "lesson_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify the lesson exists.
  const { data: lesson, error: lErr } = await admin
    .from("lessons")
    .select("id, title")
    .eq("id", lessonId)
    .maybeSingle();
  if (lErr || !lesson) {
    return new Response(JSON.stringify({ error: "lesson not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 1) Create video record on Bunny → returns guid
  const createTitle = lesson.title ? `${lesson.title} — ${filename}` : filename;
  let videoId = "";
  try {
    const cr = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, {
      method: "POST",
      headers: {
        "AccessKey": BUNNY_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ title: createTitle }),
    });
    if (!cr.ok) {
      const txt = await cr.text();
      console.error("bunny create video failed", cr.status, txt);
      return new Response(JSON.stringify({ error: `Bunny create failed (${cr.status})`, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const data = await cr.json();
    videoId = String(data?.guid || "");
    if (!videoId) throw new Error("no guid in Bunny response");
  } catch (e) {
    console.error("bunny create exception", e);
    return new Response(JSON.stringify({ error: "Bunny create exception", detail: String(e) }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2) Compute TUS authorization signature.
  // Bunny TUS docs: signature = SHA256( libraryId + apiKey + expiration + videoId )
  const expire = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
  const signature = await sha256Hex(`${BUNNY_LIBRARY_ID}${BUNNY_API_KEY}${expire}${videoId}`);

  return new Response(
    JSON.stringify({
      videoId,
      libraryId: BUNNY_LIBRARY_ID,
      authorization_signature: signature,
      authorization_expire: expire,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
