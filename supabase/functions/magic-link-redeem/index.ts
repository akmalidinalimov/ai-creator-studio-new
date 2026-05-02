// Redeems a Telegram magic-link token and returns a real Supabase session.
// Called from the React /auth/magic page.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function mintSessionForUser(admin: any, email: string, redirectTo: string) {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (linkErr) throw linkErr;
  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) throw new Error("No hashed_token returned");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anonClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (error) throw error;
  if (!data?.session) throw new Error("verifyOtp returned no session");
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SITE_URL = Deno.env.get("SITE_URL") || "";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const token = (body?.token || "").toString();
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: row } = await admin
      .from("telegram_magic_links")
      .select("token, user_id, target_path, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();

    if (!row) {
      return new Response(JSON.stringify({ error: "invalid" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (row.used_at) {
      return new Response(JSON.stringify({ error: "already_used" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: "expired" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userRow, error: userErr } = await admin.auth.admin.getUserById(row.user_id);
    if (userErr || !userRow?.user?.email) {
      return new Response(JSON.stringify({ error: "user_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const session = await mintSessionForUser(admin, userRow.user.email, `${SITE_URL}/dashboard`);
    await admin.from("telegram_magic_links").update({ used_at: new Date().toISOString() }).eq("token", token);
    // Re-engagement: mark delivery clicked
    try {
      await admin.from("re_engagement_deliveries").update({ clicked_at: new Date().toISOString() }).eq("magic_token", token).is("clicked_at", null);
    } catch (_) { /* ignore */ }
    try {
      await admin.from("nudge_log").update({ clicked_at: new Date().toISOString() }).eq("magic_token", token).is("clicked_at", null);
    } catch (_) { /* ignore */ }

    return new Response(
      JSON.stringify({ session, target_path: row.target_path || "/dashboard" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
