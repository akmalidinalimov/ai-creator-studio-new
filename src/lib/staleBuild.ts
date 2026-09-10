/**
 * Stale Mini-App / webview recovery.
 *
 * The Telegram Mini App runs in a webview that Telegram keeps ALIVE in the background and caches
 * aggressively. After a frontend deploy (chunk hashes rotate), a resumed / re-opened webview can still be
 * running the OLD build. chunkReload.ts handles the "navigate → dead lazy chunk" path (it needs the app to
 * have booted); this handles the "the whole running build is stale" path proactively, so a student who
 * re-opens the Mini App after a deploy silently gets the fresh build instead of a broken / old one.
 *
 * SCOPE: this runs ONLY inside the Telegram webview. A normal web browser honors the `no-cache` header on
 * index.html (see vercel.json) and recovers dead chunks on navigation via chunkReload, so it needs no
 * proactive reloader — and reloading on a web tab regaining focus could interrupt a lesson video / a form
 * mid-edit. The webview is the one place the aggressive cache makes this necessary, and where reloading on
 * RESUME is safe UX (the student is re-entering the app).
 *
 * How: the entry module is content-hashed (`/assets/index-<hash>.js`), so its filename IS the build id.
 * We record the hash THIS document booted with, then — a moment after boot and whenever the webview is
 * re-focused — fetch the LIVE index.html (`cache: "no-store"`, so it bypasses the webview's cache and hits
 * the current deploy) and read its entry hash. Different → this instance is stale → ONE guarded
 * cache-busting reload (shares chunkReload's loop-guard, so it can never ping-pong). Same, or unknown →
 * no-op (we only ever reload on a confirmed version change, never on uncertainty).
 */
import { reloadForStaleBuild } from "./chunkReload";
import { reportClientError } from "./beacon";
import { isTelegramWebView } from "./platform";

// Matches the entry chunk path anywhere (used on the current document's own <script> src).
const ENTRY_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;
// Matches the ENTRY module <script> tag specifically in fetched HTML (Vite emits exactly one
// `<script type="module" crossorigin src="/assets/index-<hash>.js">`). Targeting the tag — not just any
// index-*.js — keeps "latest" symmetric with how we read "current" from the DOM, so a future build that
// ever emitted another index-*.js before the entry can't cause a same-build false mismatch.
const ENTRY_SCRIPT_RE = /<script[^>]*type=["']module["'][^>]*src=["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/i;
const MIN_CHECK_INTERVAL_MS = 30_000; // don't probe more than once per 30s

let lastCheck = 0;
let booted: string | null | undefined; // undefined = not yet read

/** The entry chunk THIS document loaded — its content hash is the running build's id. */
function bootedEntry(): string | null {
  if (booted !== undefined) return booted;
  booted = null;
  try {
    const s = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    const m = (s?.getAttribute("src") || "").match(ENTRY_RE);
    if (m) booted = m[0];
  } catch { /* ignore */ }
  return booted;
}

/** The entry chunk the CURRENT deploy serves (fetched fresh, bypassing any webview cache). */
async function latestEntry(): Promise<string | null> {
  try {
    const res = await fetch(`/?_v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(ENTRY_SCRIPT_RE);
    return m ? m[1] : null;
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

  // A newer build is deployed and we're still running the old one → refresh to it, once, guarded. Put the
  // hashes IN the message so distinct transitions aren't collapsed by the beacon's (type|message) dedupe.
  reportClientError({ type: "other", message: `stale_build_reload ${current}->${latest}`, extra: { reason } });
  reloadForStaleBuild();
}

/**
 * Install the stale-build watcher — Telegram Mini App webview ONLY. Probes once shortly after boot (catches
 * a re-opened webview that booted an old cached shell) and whenever the webview is re-focused (the key
 * trigger for a Mini App resumed from the background after a deploy). Call once from main.tsx.
 */
export function installStaleBuildCheck(): void {
  if (typeof window === "undefined") return;
  try { if (!isTelegramWebView()) return; } catch { return; } // web is covered by no-cache + chunkReload
  window.setTimeout(() => { void checkOnce("boot"); }, 8_000); // after first paint + initial chunk fetches
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkOnce("resume");
  });
}
