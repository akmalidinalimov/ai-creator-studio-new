// The Mini App OPEN signal — the replacement for the magic-link click metric.
//
// A watch button used to be a magic link: its click was telegram_magic_links.used_at (and, for nudges and
// re-engagement, nudge_log / re_engagement_deliveries.clicked_at, stamped by magic-link-redeem). A web_app
// button has no token, so the Mini App reports the open itself, ONCE per tap, with the button's src/ref:
//
//   fast re-open (session cached)  POST {initData, mode:"open", src, ref, path}        → cold:false
//   fresh sign-in                  POST {initData, open:{src, ref, path}}             → cold:true
//
// Both write admin_actions 'miniapp_open' {profile_id, src, ref, path, cold} and, for a nudge / re-engagement
// src with a ref, stamp clicked_at on THAT row of THAT profile only — which keeps detect-and-nudge's rule "a
// clicked 3-day nudge suppresses the 7-day one" working without a token. The open mode resolves the profile
// by telegram_id ONLY: it never links a username and never mints a session. NEVER log initData.
import { isMiniAppSrc, isUuid, type MiniAppSrc } from "../_shared/miniapp-links.ts";

export type OpenSignal = { src: MiniAppSrc; ref: string | null; path: string | null };

const PATH_RE = /^\/[A-Za-z0-9/_-]{0,200}$/;

/** Validate an untrusted {src, ref, path}. null when src is not a known watch source. */
export function parseOpen(raw: unknown): OpenSignal | null {
  const o = (raw && typeof raw === "object") ? raw as Record<string, unknown> : null;
  if (!o || !isMiniAppSrc(o.src)) return null;
  const ref = isUuid(o.ref) ? (o.ref as string).toLowerCase() : null;
  const path = typeof o.path === "string" && PATH_RE.test(o.path) ? o.path : null;
  return { src: o.src, ref, path };
}

/** Which clicked_at table a src's ref points into, if any. */
export function clickTableFor(src: MiniAppSrc): "nudge_log" | "re_engagement_deliveries" | null {
  if (src.startsWith("nudge_")) return "nudge_log";
  if (src === "reengagement") return "re_engagement_deliveries";
  return null;
}

/**
 * Stamp clicked_at on the referenced row — only if it belongs to `profileId` and was not clicked yet (a
 * forwarded button, or someone else's ref, stamps nothing). Resolves true when a row was stamped.
 */
export async function stampClick(admin: any, table: string, ref: string, profileId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.from(table)
      .update({ clicked_at: new Date().toISOString() })
      .eq("id", ref)
      .eq("profile_id", profileId)
      .is("clicked_at", null)
      .select("id");
    if (error) {
      console.error(`miniapp_open: ${table} click stamp failed`, error.message ?? String(error));
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error(`miniapp_open: ${table} click stamp threw`, String(e));
    return false;
  }
}

/** Write the open row (+ the click stamp). Best-effort: never throws, never blocks a sign-in. */
export async function recordOpen(admin: any, profileId: string, sig: OpenSignal, cold: boolean): Promise<{ stamped: boolean }> {
  let stamped = false;
  const table = sig.ref ? clickTableFor(sig.src) : null;
  if (table && sig.ref) stamped = await stampClick(admin, table, sig.ref, profileId);
  try {
    await admin.from("admin_actions").insert({
      actor_user_id: null,
      action: "miniapp_open",
      target_user_id: profileId,
      details: { profile_id: profileId, src: sig.src, ref: sig.ref, path: sig.path, cold, stamped, at: new Date().toISOString() },
    });
  } catch (e) {
    console.error("miniapp_open: admin_actions insert threw", String(e));
  }
  return { stamped };
}

/** telegram_id → profile id, for the open mode. No username fallback, no linking. */
export async function profileIdByTelegramId(admin: any, tgId: number): Promise<string | null> {
  try {
    const { data } = await admin.from("profiles").select("id").eq("telegram_id", tgId).maybeSingle();
    return (data?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * mode:"open" — the whole handler after the HMAC check and the rate limit (index.ts). Returns the JSON body.
 * Deliberately takes only what it needs: there is no session minting or username linking on this path.
 */
export async function handleOpen(admin: any, tgId: number, body: unknown): Promise<{ ok: boolean; error?: string; stamped?: boolean }> {
  const sig = parseOpen(body);
  if (!sig) return { ok: false, error: "bad_open" };
  const profileId = await profileIdByTelegramId(admin, tgId);
  if (!profileId) return { ok: false, error: "not_linked" };
  const { stamped } = await recordOpen(admin, profileId, sig, false);
  return { ok: true, stamped };
}
