// Resolves the URL for any lesson video source (upload | youtube | vimeo | mux | bunny).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!who?.user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { lessonId } = await req.json();
    if (!lessonId) return new Response(JSON.stringify({ error: "lessonId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: lesson } = await admin
      .from("lessons")
      .select("video_provider, video_url, video_storage_path, provider_video_id, published, modules:module_id(course_id)")
      .eq("id", lessonId)
      .maybeSingle();

    if (!lesson) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Authorization: admins bypass; everyone else must be enrolled AND the lesson must be published.
    const userId = who.user.id;
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["admin", "superadmin"])
      .maybeSingle();
    const isAdmin = !!roleRow;

    if (!isAdmin) {
      if (!lesson.published) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const courseId = (lesson as any).modules?.course_id;
      if (!courseId) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { data: enr } = await admin
        .from("enrollments")
        .select("user_id")
        .eq("user_id", userId)
        .eq("course_id", courseId)
        .maybeSingle();
      if (!enr) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    let url: string | null = null;
    let kind: "mp4" | "hls" | "iframe" = "mp4";

    switch (lesson.video_provider) {
      case "upload": {
        if (lesson.video_storage_path) {
          const { data, error } = await admin.storage.from("lesson-videos").createSignedUrl(lesson.video_storage_path, 60 * 60 * 4);
          if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          url = data?.signedUrl ?? null;
        } else if (lesson.video_url) {
          url = lesson.video_url;
        }
        kind = "mp4";
        break;
      }
      case "youtube": {
        const id = lesson.provider_video_id ?? "";
        url = `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`;
        kind = "iframe";
        break;
      }
      case "vimeo": {
        url = `https://player.vimeo.com/video/${lesson.provider_video_id ?? ""}`;
        kind = "iframe";
        break;
      }
      case "mux": {
        url = `https://stream.mux.com/${lesson.provider_video_id ?? ""}.m3u8`;
        kind = "hls";
        break;
      }
      case "bunny": {
        // provider_video_id format expected: "<library_id>/<video_guid>".
        // If only the GUID was pasted, prepend the configured BUNNY_LIBRARY_ID.
        let id = (lesson.provider_video_id ?? "").trim();
        if (id && !id.includes("/")) {
          const lib = Deno.env.get("BUNNY_LIBRARY_ID") || "";
          if (lib) id = `${lib}/${id}`;
        }
        url = `https://iframe.mediadelivery.net/embed/${id}`;
        kind = "iframe";
        break;
      }
    }

    return new Response(JSON.stringify({ url, kind }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
