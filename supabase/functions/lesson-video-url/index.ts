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
      .select("module_id, video_provider, video_url, video_storage_path, provider_video_id, published, modules:module_id(course_id)")
      .eq("id", lessonId)
      .maybeSingle();

    if (!lesson) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Authorization: admins bypass everything (including unpublished). A teacher of this
    // lesson's course bypasses the module-limit/tier gate, the provisional check, and the
    // enrollment check — but still needs a published lesson, same as students (teachers review
    // a course's published material, not drafts). Everyone else (students) faces every gate
    // below, unchanged.
    const userId = who.user.id;
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["admin", "superadmin"])
      .maybeSingle();
    const isAdmin = !!roleRow;

    const courseId = (lesson as any).modules?.course_id ?? null;

    // isTeacherOfCourse: does this user teach a group on this course? Junction-aware
    // (primary groups.teacher_id ∪ co-teacher group_teachers) via the teacher_group_ids(uid)
    // RPC (SECURITY DEFINER, junction-aware since #86/#88 "multi-teacher per group").
    let isTeacherOfCourse = false;
    if (!isAdmin && courseId) {
      const { data: teacherGroupIds } = await admin.rpc("teacher_group_ids", { _uid: userId });
      const groupIds = (teacherGroupIds ?? []) as string[];
      if (groupIds.length > 0) {
        const { data: taughtGroup } = await admin
          .from("groups")
          .select("id")
          .eq("course_id", courseId)
          .in("id", groupIds)
          .limit(1);
        isTeacherOfCourse = (taughtGroup?.length ?? 0) > 0;
      }
    }
    const isStaff = isAdmin || isTeacherOfCourse;

    // has_module_access (tier/module-limit gate): enforced for students only. Admins and
    // teachers-of-course review the whole course, not their students' tier/module limit.
    if (!isStaff) {
      const { data: __allowed } = await admin.rpc("has_module_access", { _user_id: userId, _module_id: (lesson as any).module_id });
      if (!__allowed) {
        return new Response(JSON.stringify({ error: "module_locked" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Published: required for every non-admin caller, including a teacher-of-course.
    if (!isAdmin && !lesson.published) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!isStaff) {
      // Provisional (trial) accounts get homework/XP/profile but NO lessons — the real content gate.
      // Paid accounts (default) pass through. Admins/teachers-of-course already bypassed above.
      const { data: prof } = await admin.from("profiles").select("account_type").eq("id", userId).maybeSingle();
      if ((prof as any)?.account_type === "provisional") {
        return new Response(JSON.stringify({ error: "provisional_locked" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
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
    let bunny: { lib: string; guid: string } | null = null;

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
        const [blib, bguid] = id.split("/");
        if (blib && bguid) bunny = { lib: blib, guid: bguid };
        url = `https://iframe.mediadelivery.net/embed/${id}`;
        kind = "iframe";
        break;
      }
    }

    return new Response(JSON.stringify({ url, kind, provider: lesson.video_provider, bunny }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
