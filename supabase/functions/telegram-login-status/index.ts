// Polled by the originating browser. Returns a real Supabase session
// (access + refresh tokens) once the bot has authenticated the user.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function mintSessionForUser(admin: any, email: string, redirectTo: string) {
  // Use generateLink to obtain a hashed token, then verify it server-side
  // so we get back a real { access_token, refresh_token } pair.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (linkErr) throw linkErr;
  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) throw new Error("No hashed_token returned from generateLink");

  // Use a non-admin client so the resulting session isn't bound to the service role.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (verifyErr) throw verifyErr;
  if (!verifyData?.session) throw new Error("verifyOtp returned no session");
  return {
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
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
      .from("telegram_login_tokens")
      .select("token, status, user_id, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!row) {
      return new Response(JSON.stringify({ status: "expired" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expired = new Date(row.expires_at).getTime() < Date.now();
    if (row.status === "pending") {
      if (expired) {
        await admin.from("telegram_login_tokens").update({ status: "expired" }).eq("token", token);
        return new Response(JSON.stringify({ status: "expired" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "pending" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (row.status === "authenticated" && row.user_id) {
      // Look up email
      const { data: userRow, error: userErr } = await admin.auth.admin.getUserById(row.user_id);
      if (userErr || !userRow?.user?.email) {
        return new Response(JSON.stringify({ status: "expired", error: "user not found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const session = await mintSessionForUser(admin, userRow.user.email, `${SITE_URL}/dashboard`);
      // Burn the token so it can't be reused
      await admin.from("telegram_login_tokens").delete().eq("token", token);
      return new Response(JSON.stringify({ status: "authenticated", session }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: "expired" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
