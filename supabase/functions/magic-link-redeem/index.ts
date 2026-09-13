// Redeems a Telegram magic-link token and returns a real Supabase session.
// Called from the React /auth/magic page.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { logHealth } from "../_shared/edge.ts";

// Kept local (NOT _shared/edge.ts's): this endpoint is called by the browser with the supabase-js
// client headers, and narrowing the allow-list here would break the redeem with a CORS error.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// A single-use link that is opened TWICE in quick succession is the normal case, not an attack:
// Telegram's in-app browser opens it and the student then reopens it in their real browser, a flaky
// tap fires twice, or the page re-runs its redeem. Before 2026-09-13 the second open returned 410 and
// the student saw "Couldn't sign in" even though the first open had worked — 48 of 98 redeems in 24h.
// Re-minting inside a short window is safe: it is the SAME bearer token, already in the same hands,
// for a couple of minutes. After the window the link is dead for good, so a leaked old link stays
// worthless. `used_at` is stamped only on the FIRST redeem, so replays can never extend the window.
const REPLAY_GRACE_MS = 120_000;

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
      .select("token, user_id, purpose, target_path, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();

    if (!row) {
      await logHealth(admin, "magic_link_unknown_token", {}, { source: "magic-link-redeem" });
      return new Response(JSON.stringify({ error: "invalid" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (row.used_at) {
      const ageMs = Date.now() - new Date(row.used_at).getTime();
      const withinGrace = ageMs >= 0 && ageMs <= REPLAY_GRACE_MS;
      // DB-visible by construction: before this, a replay existed ONLY in raw edge logs, so a failure
      // hitting half of all bot-link opens was invisible to every watchdog and to the owner.
      await logHealth(admin, "magic_link_replay", {
        purpose: row.purpose, age_seconds: Math.round(ageMs / 1000), regranted: withinGrace,
      }, { source: "magic-link-redeem", targetUserId: row.user_id });
      if (!withinGrace) {
        return new Response(JSON.stringify({ error: "used", message: "This link has already been used. Open the bot and tap the button again to get a fresh one." }), {
          status: 410,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // inside the grace window → fall through and mint again
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await logHealth(admin, "magic_link_expired_open", {
        purpose: row.purpose,
        age_days: Math.round((Date.now() - new Date(row.expires_at).getTime()) / 86_400_000),
      }, { source: "magic-link-redeem", targetUserId: row.user_id });
      return new Response(JSON.stringify({ error: "expired", message: "This bot link has expired. Open the bot and tap the button again to get a fresh one." }), {
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
    // `.is("used_at", null)` keeps the FIRST use as the clock for REPLAY_GRACE_MS — without it a
    // client retrying every minute would roll the window forward and the link would never die.
    await admin.from("telegram_magic_links")
      .update({ used_at: new Date().toISOString() })
      .eq("token", token)
      .is("used_at", null);
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
