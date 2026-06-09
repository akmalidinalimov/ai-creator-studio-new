// Admin "log in as" — issues a short-lived magic link for a teacher/student.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SITE_URL = Deno.env.get("SITE_URL") || "";

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: who } = await userClient.auth.getUser();
    if (!who?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", who.user.id);
    const callerRoleSet = new Set((callerRoles || []).map((r: any) => r.role));
    if (!callerRoleSet.has("admin") && !callerRoleSet.has("superadmin")) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const telegram_username = (body?.telegram_username || "").toString().trim();
    const telegram_id = (body?.telegram_id ?? "").toString().trim();
    const user_id = (body?.user_id || "").toString().trim();

    let query = admin.from("profiles").select("id, name, last_name, telegram_username, telegram_id");
    if (user_id) {
      query = query.eq("id", user_id);
    } else if (telegram_id) {
      const digits = telegram_id.replace(/[^0-9]/g, "");
      if (!digits) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      query = query.eq("telegram_id", Number(digits));
    } else if (telegram_username) {
      const uname = telegram_username.replace(/^@/, "").toLowerCase();
      query = query.ilike("telegram_username", uname);
    } else {
      return new Response(JSON.stringify({ error: "missing_target" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: matches, error: matchErr } = await query.limit(5);
    if (matchErr) throw matchErr;
    if (!matches || matches.length === 0) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (matches.length > 1) {
      return new Response(JSON.stringify({ error: "ambiguous" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const target = matches[0] as any;

    if (target.id === who.user.id) {
      return new Response(JSON.stringify({ error: "cannot_impersonate_self" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: tRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", target.id);
    const tRoleSet = new Set((tRoles || []).map((r: any) => r.role));
    if (tRoleSet.has("admin") || tRoleSet.has("superadmin")) {
      return new Response(JSON.stringify({ error: "cannot_impersonate_admin" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token =
      crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "");

    const { error: insErr } = await admin.from("telegram_magic_links").insert({
      token,
      user_id: target.id,
      target_path: "/dashboard",
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    if (insErr) throw insErr;

    try {
      await admin.from("audit_log").insert({
        actor_user_id: who.user.id,
        target_user_id: target.id,
        action: "impersonate_start",
        new_value: { surface: "web" },
      });
    } catch (_) { /* ignore */ }

    const name =
      ((target.name ? target.name : "") + (target.last_name ? " " + target.last_name : "")) ||
      target.telegram_username ||
      "user";
    const trimmed = name.toString().trim();
    const url =
      SITE_URL + "/auth/magic?token=" + token + "&imp=1&as=" + encodeURIComponent(trimmed);

    return new Response(JSON.stringify({ url, name: trimmed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("admin-impersonate error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
