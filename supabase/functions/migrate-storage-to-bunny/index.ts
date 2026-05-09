// Admin-only one-shot migration: copy a single lesson's video from Supabase
// Storage (lesson-videos bucket) to Bunny Stream, then update the lesson row.
//
// POST { lesson_id: string }  →  { ok: true, libraryId, videoId }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const BUNNY_LIBRARY_ID = Deno.env.get("BUNNY_LIBRARY_ID") || "";
  const BUNNY_API_KEY = Deno.env.get("BUNNY_API_KEY") || "";

  if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) {
    return json({ error: "Bunny is not configured" }, 500);
  }

  // Verify admin caller
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: userData, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return json({ error: "forbidden" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const lessonId = String(body?.lesson_id || "").trim();
  if (!lessonId) return json({ error: "lesson_id required" }, 400);

  const { data: lesson, error: lErr } = await admin
    .from("lessons")
    .select("id, title, video_provider, video_storage_path, thumbnail_path")
    .eq("id", lessonId)
    .maybeSingle();
  if (lErr || !lesson) return json({ error: "lesson not found" }, 404);
  if (lesson.video_provider !== "upload" || !lesson.video_storage_path) {
    return json({ error: "lesson is not a Storage upload" }, 400);
  }

  // 1) Signed download URL from Storage
  const { data: signed, error: sErr } = await admin
    .storage
    .from("lesson-videos")
    .createSignedUrl(lesson.video_storage_path, 60 * 60);
  if (sErr || !signed?.signedUrl) return json({ error: `sign download failed: ${sErr?.message}` }, 500);

  // 2) Create Bunny video
  const createTitle = lesson.title || "Migrated video";
  const cr = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, {
    method: "POST",
    headers: { AccessKey: BUNNY_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ title: createTitle }),
  });
  if (!cr.ok) {
    const t = await cr.text();
    return json({ error: `Bunny create failed (${cr.status}): ${t}` }, 502);
  }
  const created = await cr.json();
  const videoId = String(created?.guid || "");
  if (!videoId) return json({ error: "Bunny did not return a guid" }, 502);

  // 3) Stream Storage → Bunny PUT
  const dl = await fetch(signed.signedUrl);
  if (!dl.ok || !dl.body) {
    return json({ error: `download from storage failed (${dl.status})` }, 502);
  }
  const put = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`, {
    method: "PUT",
    headers: { AccessKey: BUNNY_API_KEY, "Content-Type": "application/octet-stream" },
    body: dl.body,
  });
  if (!put.ok) {
    const t = await put.text();
    return json({ error: `Bunny upload failed (${put.status}): ${t}` }, 502);
  }

  // 4) Update lesson row
  const { error: upErr } = await admin
    .from("lessons")
    .update({
      video_provider: "bunny",
      provider_video_id: `${BUNNY_LIBRARY_ID}/${videoId}`,
      video_storage_path: null,
      video_url: null,
    })
    .eq("id", lessonId);
  if (upErr) return json({ error: `lesson update failed: ${upErr.message}` }, 500);

  // 5) Best-effort delete original from Storage
  try {
    await admin.storage.from("lesson-videos").remove([lesson.video_storage_path]);
  } catch (_e) { /* ignore */ }

  return json({ ok: true, libraryId: BUNNY_LIBRARY_ID, videoId });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
