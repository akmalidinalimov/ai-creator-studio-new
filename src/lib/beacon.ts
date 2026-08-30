/**
 * Client error/health beacon — reports browser-side failures the server can't see (render crashes,
 * 404'd lazy chunks, backend-unreachable fetches, video-player failures) into client_error_events, so
 * they become DB-visible + alertable BEFORE a student complains.
 *
 * Design:
 *  - Transport is the same-origin `/sb` proxy → the beacon lands even when the client can't reach
 *    supabase.co directly (the exact "backend unreachable" case). It works as long as the app loaded.
 *  - `fetch(..., { keepalive:true })` (not sendBeacon — that can't set the apikey header Kong needs) so
 *    the beacon completes even if the page is about to reload (chunk recovery) or navigate away.
 *  - STRICTLY best-effort: it never throws, never blocks the UI, and self-throttles so a crash loop
 *    can't flood (dedupe identical events for a window + a hard per-session cap). The server also
 *    dedupes + flood-shields.
 *  - No secrets: only a short error string + route + a client session id are sent; the auth token is
 *    used transiently (Authorization header, best-effort) so the server can attribute a user_id, and is
 *    never stored.
 */
import { SB_BASE } from "@/lib/supabaseBase";
import { isTelegramWebView } from "@/lib/platform";

export type BeaconType =
  | "chunk_load" | "render_crash" | "unhandled_error" | "unhandled_rejection"
  | "backend_unreachable" | "video_error" | "other";

const SID_KEY = "beacon_sid";
const DEDUPE_MS = 60_000;   // don't re-send an identical (type,message) within this window
const SESSION_CAP = 40;     // hard cap of beacons per page-session (crash-loop guard)

const recent = new Map<string, number>();
let sent = 0;

function sessionId(): string {
  try {
    let sid = localStorage.getItem(SID_KEY);
    if (!sid) {
      sid = (globalThis.crypto?.randomUUID?.() ?? `sid_${Math.random().toString(36).slice(2)}${Date.now()}`);
      localStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return "no_storage";
  }
}

/** Best-effort read of the current Supabase access token from localStorage (so the server can resolve
 *  user_id). Independent of the supabase client so the beacon works even if that client is broken. */
function accessTokenBestEffort(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.endsWith("-auth-token")) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const v = JSON.parse(raw);
      const tok = v?.access_token ?? v?.currentSession?.access_token;
      if (typeof tok === "string" && tok.length > 20) return tok;
    }
  } catch { /* ignore */ }
  return null;
}

export function reportClientError(opts: {
  type: BeaconType;
  message?: string;
  route?: string;
  extra?: Record<string, unknown>;
}): void {
  try {
    if (typeof window === "undefined") return;
    if (sent >= SESSION_CAP) return;

    const message = (opts.message ?? "").slice(0, 500);
    const key = `${opts.type}|${message}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < DEDUPE_MS) return;
    recent.set(key, now);

    const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
    const headers: Record<string, string> = { "Content-Type": "application/json", apikey };
    const tok = accessTokenBestEffort();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    // Surface WHICH surface failed. user_agent can't tell iOS Telegram webview from Safari, so we
    // stamp every beacon with an explicit flag → the watchdog can isolate a Mini-App-only spike
    // (extra->>'miniapp' = 'true') instead of it hiding under combined web+mini-app thresholds.
    let miniapp = false;
    try { miniapp = isTelegramWebView(); } catch { /* best-effort */ }

    const body = JSON.stringify({
      event_type: opts.type,
      message,
      route: (opts.route ?? window.location?.pathname ?? "").slice(0, 300),
      session_id: sessionId(),
      app_version: (import.meta.env.VITE_APP_VERSION as string) || undefined,
      extra: { ...(opts.extra || {}), miniapp },
    });

    sent++;
    // Fire-and-forget; keepalive lets it survive an imminent reload/navigation. Swallow all errors.
    void fetch(`${SB_BASE}/functions/v1/client-beacon`, { method: "POST", headers, body, keepalive: true })
      .catch(() => {});
  } catch {
    /* a beacon must never affect the app */
  }
}

/** Install global listeners for uncaught errors / rejections. Call once from main.tsx. */
export function installGlobalBeacons(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    // Ignore ResourceLoad errors with no message (extensions, cross-origin noise).
    const msg = e?.message || (e?.error && String(e.error)) || "";
    if (!msg) return;
    reportClientError({ type: "unhandled_error", message: msg, extra: { file: (e as any)?.filename, line: (e as any)?.lineno } });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent)?.reason;
    const msg = r instanceof Error ? `${r.name}: ${r.message}` : (r ? String(r) : "");
    if (!msg) return;
    reportClientError({ type: "unhandled_rejection", message: msg.slice(0, 500) });
  });
}
