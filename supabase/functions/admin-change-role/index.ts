// Admin/superadmin: change a user's role via SECURITY DEFINER RPC.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: who } = await userClient.auth.getUser(auth.replace("Bearer ", ""));
    if (!who?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { target_user_id, new_role } = await req.json();
    if (!target_user_id || !new_role) {
      return new Response(JSON.stringify({ error: "target_user_id and new_role required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!["student", "teacher", "admin", "superadmin"].includes(new_role)) {
      return new Response(JSON.stringify({ error: "invalid new_role" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { error } = await userClient.rpc("admin_change_role", { _target: target_user_id, _new_role: new_role });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
