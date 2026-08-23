// client-beacon: the client-tier health signal. The browser POSTs a small error/health event here
// (via the same-origin /sb proxy, so it lands even when the client can't reach supabase.co directly).
// verify_jwt = false — a logged-OUT user's failure (e.g. login "Load failed") must still beacon.
// Strictly best-effort: always returns 200, never signals the client to retry. Validates + caps +
// rate-limits (anon endpoint). Inserts into public.client_error_events via the service role.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const ALLOWED = new Set([
  "chunk_load", "render_crash", "unhandled_error", "unhandled_rejection",
  "backend_unreachable", "video_error", "other",
]);
const MAX_BODY = 20_000; // a legitimate beacon is a few hundred bytes
const cap = (s: unknown, n: number): string | null => {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
};
// Never persist anything secret from `extra` — filter by key name AND value shape.
const SECRET_KEY = /(token|secret|password|apikey|authorization|initdata|jwt|bearer)/i;
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/; // JWT-ish
function sanitizeExtra(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Record<string, unknown> = {};
  let kept = 0, seen = 0;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (seen++ >= 200) break;   // bound total iteration regardless of keep/skip (attacker-body DoS guard)
    if (kept >= 15) break;
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "object" && v !== null) continue; // shallow only
    let val: unknown = typeof v === "string" ? cap(v, 200) : v;
    if (typeof val === "string" && TOKEN_SHAPE.test(val)) continue; // drop token-shaped values
    out[k] = val;
    kept++;
  }
  return Object.keys(out).length ? out : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return ok(); // never error a beacon
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return ok(); // reject oversized before parsing

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));

    const event_type = ALLOWED.has(String(body?.event_type)) ? String(body.event_type) : "other";
    const message = cap(body?.message, 500);
    const route = cap(body?.route, 300);
    const app_version = cap(body?.app_version, 80);
    const user_agent = cap(req.headers.get("user-agent"), 300);
    const extra = sanitizeExtra(body?.extra);

    // Session id: prefer the client-generated one; else fall back to the caller IP so session-less
    // traffic is still deduped AND counted by the watchdog's distinct-session alarms (never NULL).
    let session_id = cap(body?.session_id, 120);
    if (!session_id) {
      const ip = (req.headers.get("cf-connecting-ip")
        || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "").slice(0, 100);
      session_id = ip ? "ip:" + ip : "unknown";
    }

    // Best-effort user resolution (verify_jwt=false → not auto-verified; resolve if a token is present).
    let user_id: string | null = null;
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (jwt && jwt !== Deno.env.get("SUPABASE_ANON_KEY")) {
      try { const { data } = await admin.auth.getUser(jwt); user_id = data?.user?.id ?? null; }
      catch (e) { console.error("beacon getUser", e); }
    }

    // Anti-abuse: shed load fast with the cheap global flood check FIRST, then dedupe a session that
    // hammers one event_type. Fail-open (a rate-check error must not silently drop a legit beacon).
    try {
      const { count: recent } = await admin.from("client_error_events").select("id", { count: "exact", head: true })
        .gt("created_at", new Date(Date.now() - 60_000).toISOString());
      if ((recent || 0) > 600) return ok(); // global flood shield
      const { count } = await admin.from("client_error_events").select("id", { count: "exact", head: true })
        .eq("session_id", session_id).eq("event_type", event_type)
        .gt("created_at", new Date(Date.now() - 30_000).toISOString());
      if ((count || 0) > 0) return ok(); // deduped within 30s (per session/ip + type)
    } catch (e) { console.error("beacon ratecheck", e); /* fail-open */ }

    const { error } = await admin.from("client_error_events").insert({
      event_type, message, route, user_id, session_id, app_version, user_agent, extra,
    });
    if (error) console.error("beacon insert", error.message);
    return ok();
  } catch (e) {
    console.error("beacon", e);
    return ok(); // a beacon must never surface an error to the client
  }
});
