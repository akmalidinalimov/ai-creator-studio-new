// Generates a 1080x1080 Instagram-shareable PNG celebrating a student's module completion.
// Uses Lovable AI Gateway (Nano Banana). Uploads to public storage bucket "module-shares".
// Upserts a row in module_celebrations so the in-app modal can show it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const INSTAGRAM_HANDLE = "@aicreators_uz";
// Was Lovable's AI gateway (needs LOVABLE_API_KEY, unavailable off Lovable).
// Now uses OpenAI's image API directly with the platform's OPENAI_API_KEY.
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

function captionFor(moduleNumber: number, moduleTitle: string, fullName: string) {
  return [
    `🎉 Modul ${moduleNumber} tamomlandi: ${moduleTitle}!`,
    `AI Creators kursida ${fullName} sifatida o'sishda davom etyapman 🚀`,
    "",
    `${INSTAGRAM_HANDLE} ni tag qiling va biz ham ulashamiz!`,
    "#aicreators #aiuzbekistan #onlinekurs",
  ].join("\n");
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes(",") ? base64.split(",")[1] : base64; // tolerate data: URLs
  const bin = atob(clean || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.headers.get("x-internal-secret") !== Deno.env.get("INTERNAL_FN_SECRET")) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { user_id?: string; module_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: corsHeaders });
  }
  const { user_id, module_id } = body;
  if (!user_id || !module_id) {
    return new Response(JSON.stringify({ error: "user_id and module_id required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("name, last_name")
      .eq("id", user_id)
      .maybeSingle();
    const { data: module } = await admin
      .from("modules")
      .select("id, title, position")
      .eq("id", module_id)
      .maybeSingle();
    if (!module) {
      return new Response(JSON.stringify({ error: "module not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    const fullName =
      [profile?.name, (profile as any)?.last_name].filter(Boolean).join(" ") || "Student";
    const moduleNumber = (module.position ?? 0) + 1;

    // Skip if already generated
    const { data: existing } = await admin
      .from("module_celebrations")
      .select("id, image_url")
      .eq("user_id", user_id)
      .eq("module_id", module_id)
      .maybeSingle();
    if (existing?.image_url) {
      return new Response(JSON.stringify({ ok: true, image_url: existing.image_url, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = `Create a celebratory 1:1 square Instagram card. Brand: AI Creators (modern, bold, vibrant violet to pink gradient background). Big bold headline at center: "Modul ${moduleNumber} tamomlandi!". Subhead with the module title in clean sans-serif: "${module.title}". Below it, the student name in a smaller elegant style: "${fullName}". Bottom-right corner footer text: "${INSTAGRAM_HANDLE} · aicreators". Modern minimal typography, no extra decorations, no watermarks, no other text. High contrast, optimized for Instagram feed.`;

    const aiResp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        n: 1,
      }),
    });
    if (!aiResp.ok) {
      const txt = await aiResp.text();
      console.error("OpenAI image error", aiResp.status, txt);
      return new Response(JSON.stringify({ error: "image generation failed", status: aiResp.status }), {
        status: 502,
        headers: corsHeaders,
      });
    }
    const aiData = await aiResp.json();
    const b64: string | undefined = aiData?.data?.[0]?.b64_json;
    if (!b64) {
      return new Response(JSON.stringify({ error: "no image returned" }), {
        status: 502,
        headers: corsHeaders,
      });
    }

    const bytes = base64ToBytes(b64);
    const path = `${user_id}/${module_id}.png`;
    const { error: upErr } = await admin.storage
      .from("module-shares")
      .upload(path, bytes, { upsert: true, contentType: "image/png" });
    if (upErr) {
      console.error("storage upload error", upErr);
      return new Response(JSON.stringify({ error: "storage upload failed" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
    const { data: pub } = admin.storage.from("module-shares").getPublicUrl(path);
    const image_url = pub.publicUrl;
    const caption = captionFor(moduleNumber, module.title, fullName);

    await admin
      .from("module_celebrations")
      .upsert(
        { user_id, module_id, image_url, caption },
        { onConflict: "user_id,module_id" },
      );

    return new Response(JSON.stringify({ ok: true, image_url, caption, module_number: moduleNumber }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-module-share-image error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "unknown" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
