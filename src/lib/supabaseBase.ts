/**
 * Base URL for all Supabase traffic.
 *
 * Auth / data / storage / edge-function requests are routed through a
 * SAME-ORIGIN path (`/sb`) that Vercel rewrites to the Supabase host (see
 * vercel.json). Reason: some student networks (regional ISP / carrier filtering,
 * common in Uzbekistan) can reach our app domain but NOT `*.supabase.co`
 * directly, so the browser fetch fails with "Load failed" and they can neither
 * log in nor load courses. Proxying through our own origin — which they CAN
 * reach — makes the backend reachable again, and makes every request same-origin
 * (so there is no CORS at all).
 *
 * Domain-agnostic on purpose: derived from the current origin, so it works on
 * the vercel.app fallback, the custom domain, and any future domain with no
 * per-domain config. Falls back to the direct URL when there is no `window`
 * (defensive — the app is a browser SPA).
 */
const PROXY_PREFIX = "/sb";

export const SB_BASE: string =
  typeof window !== "undefined" && window.location?.origin
    ? `${window.location.origin}${PROXY_PREFIX}`
    : (import.meta.env.VITE_SUPABASE_URL as string);

/**
 * The DIRECT Supabase host (no proxy). ONLY for realtime websockets, which a
 * Vercel HTTP rewrite cannot upgrade. Everything else must use {@link SB_BASE}.
 */
export const SB_DIRECT_URL: string = import.meta.env.VITE_SUPABASE_URL as string;
