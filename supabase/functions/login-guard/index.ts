// Soft-lockout guard. Two actions:
//   { action: "check", email }                     -> { locked, locked_until_ms?, message? }
//   { action: "record", email, success: bool }     -> { ok }
// Lockout: 5+ failures in last 10 minutes for the email OR IP -> 15-minute lockout.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WINDOW_MIN = 10;
const LOCKOUT_MIN = 15;
const FAIL_LIMIT = 5;

function getIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "";
  return (fwd.split(",")[0] || "unknown").trim().toLowerCase();
}

async function lockoutFor(admin: any, kind: "email" | "ip", key: string): Promise<number | null> {
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
  const { data } = await admin
    .from("login_attempts")
    .select("created_at, success")
    .eq("kind", kind)
    .eq("key", key)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = data || [];
  const fails = rows.filter((r: any) => !r.success);
  if (fails.length < FAIL_LIMIT) return null;
  // Lock until last fail + LOCKOUT_MIN
  const lastFail = new Date(fails[0].created_at).getTime();
  const until = lastFail + LOCKOUT_MIN * 60_000;
  return until > Date.now() ? until : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json();
    const action: string = body.action;
    const email: string = (body.email || "").trim().toLowerCase();
    const ip = getIp(req);
    const ua = (req.headers.get("user-agent") || "").slice(0, 200);

    if (!email) {
      return new Response(JSON.stringify({ error: "email required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "check") {
      const lockEmail = await lockoutFor(admin, "email", email);
      const lockIp = ip !== "unknown" ? await lockoutFor(admin, "ip", ip) : null;
      const until = Math.max(lockEmail || 0, lockIp || 0);
      if (until > Date.now()) {
        const minutes = Math.ceil((until - Date.now()) / 60_000);
        return new Response(
          JSON.stringify({
            locked: true,
            locked_until_ms: until,
            message: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ locked: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "record") {
      const success = !!body.success;
      // Insert two rows: one for email, one for ip
      await admin.from("login_attempts").insert([
        { key: email, kind: "email", success, user_agent: ua },
        ...(ip !== "unknown" ? [{ key: ip, kind: "ip", success, user_agent: ua }] : []),
      ]);
      // On success, clear recent failures for this email so user isn't held back
      if (success) {
        const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
        await admin.from("login_attempts").delete().eq("kind", "email").eq("key", email).eq("success", false).gte("created_at", since);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
