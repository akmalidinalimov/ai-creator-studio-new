/**
 * Stale Mini-App / webview recovery.
 *
 * The Telegram Mini App runs in a webview that Telegram keeps ALIVE in the background and caches
 * aggressively. After a frontend deploy (chunk hashes rotate), a resumed / re-opened webview can still be
 * running the OLD build. chunkReload.ts handles the "navigate → dead lazy chunk" path (it needs the app to
 * have booted); this handles the "the whole running build is stale" path proactively, so a student who
 * re-opens the Mini App after a deploy silently gets the fresh build instead of a broken / old one.
 *
 * How: the entry module is content-hashed (`/assets/index-<hash>.js`), so its filename IS the build id.
 * We record the hash THIS document booted with, then — a moment after boot and whenever the webview is
 * re-focused — fetch the LIVE index.html (`cache: "no-store"`, so it bypasses the webview's cache and hits
 * the current deploy) and read its entry hash. Different → this instance is stale → ONE guarded
 * cache-busting reload (shares chunkReload's loop-guard, so it can never ping-pong). Same, or unknown →
 * no-op (we only ever reload on a confirmed version change, never on uncertainty).
 *
 * Cheap + safe: the probe is a ~3KB fetch, throttled, best-effort (never throws), and only ever runs one
 * reload per guard window. Reloading on RESUME is the right UX — the student is re-entering the app, not
 * mid-action.
 */
import { reloadForStaleBuild } from "./chunkReload";
import { reportClientError } from "./beacon";

const ENTRY_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;
const MIN_CHECK_INTERVAL_MS = 30_000; // don't probe more than once per 30s (tab in/out spam guard)

let lastCheck = 0;
let booted: string | null | undefined; // undefined = not yet read, null/"" = unknown

/** The entry chunk THIS document loaded — its content hash is the running build's id. */
function bootedEntry(): string | null {
  if (booted !== undefined) return booted || null;
  try {
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'));
    for (const s of scripts) {
      const m = (s.getAttribute("src") || "").match(ENTRY_RE);
      if (m) { booted = m[0]; return booted; }
    }
  } catch { /* ignore */ }
  booted = null;
  return null;
}

/** The entry chunk the CURRENT deploy serves (fetched fresh, bypassing any webview cache). */
async function latestEntry(): Promise<string | null> {
  try {
    const res = await fetch(`/?_v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(ENTRY_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function checkOnce(reason: string): Promise<void> {
  const now = Date.now();
  if (now - lastCheck < MIN_CHECK_INTERVAL_MS) return;
  lastCheck = now;

  const current = bootedEntry();
  if (!current) return; // dev build / unexpected markup — nothing to compare against
  const latest = await latestEntry();
  if (!latest || latest === current) return; // fresh, or couldn't tell — never reload on uncertainty

  // A newer build is deployed and we're still running the old one → refresh to it, once, guarded.
  reportClientError({ type: "other", message: "stale_build_reload", extra: { from: current, to: latest, reason } });
  reloadForStaleBuild();
}

/**
 * Install the stale-build watcher. Probes once shortly after boot (catches a re-opened webview that booted
 * an old cached shell) and whenever the tab / Mini-App webview is re-focused (the key trigger for a Telegram
 * Mini App resumed from the background after a deploy). Call once from main.tsx.
 */
export function installStaleBuildCheck(): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => { void checkOnce("boot"); }, 8_000); // after first paint + initial chunk fetches
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkOnce("resume");
  });
}
