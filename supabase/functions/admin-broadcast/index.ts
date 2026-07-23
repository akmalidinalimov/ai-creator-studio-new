// admin-broadcast: the WEB entry point. A logged-in admin composes a broadcast; this authenticates
// via their Supabase JWT + role, then delegates to the shared createBroadcast() (see _shared/
// broadcast-core.ts). The Telegram Mini App entry point (tg-broadcast) shares the same core.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createBroadcast } from "../_shared/broadcast-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Caller must be an admin/superadmin.
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: who } = await admin.auth.getUser(jwt);
  const uid = who?.user?.id;
  if (!uid) return json({ error: "unauthorized" }, 401);
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", uid).in("role", ["admin", "superadmin"]);
  if (!roles?.length) return json({ error: "forbidden" }, 403);

  const b = await req.json().catch(() => ({}));
  const { status, body } = await createBroadcast(admin, {
    course_id: String(b?.course_id || ""),
    image_path: b?.image_path ? String(b.image_path) : null,
    body_uz: String(b?.body_uz || ""),
    body_ru: b?.body_ru ? String(b.body_ru) : null,
    body_en: b?.body_en ? String(b.body_en) : null,
    button_label: b?.button_label ? String(b.button_label).slice(0, 64) : null,
    button_url: b?.button_url ? String(b.button_url).slice(0, 512) : null,
    mode: b?.mode === "all" ? "all" : "test",
    actor_uid: uid,
  });
  return json(body, status);
});
