/**
 * Stale-deploy recovery for lazily-loaded route chunks.
 *
 * The app code-splits every route (`React.lazy(() => import(...))`). Each build
 * stamps a fresh content hash into the chunk filenames. When a tab stays open
 * across a deploy (we ship several times a day), its in-memory `index.html`
 * still references the OLD hashes. The moment the user navigates to a route
 * whose chunk hasn't been fetched yet, the dynamic `import()` 404s, the
 * rejection rethrows through <Suspense> into the top-level ErrorBoundary, and
 * the user sees "Nimadir noto'g'ri ketdi" — which reads to them as "there's a
 * platform update". A plain soft reload that keeps serving a cached stale index
 * hits the same dead chunk and loops forever.
 *
 * Fix: on a chunk-load failure, force ONE cache-busting full reload to pull the
 * freshly-deployed index + manifest. Hard-guarded so it can NEVER loop — if we
 * already reloaded once and it still fails, we stop and let the UI show manual
 * recovery guidance (hard-refresh / clear cache) instead of trapping the user.
 */

const CB_PARAM = "cb";
const GUARD_KEY = "__chunk_reload_ts";
/** If an auto-reload happened within this window, don't auto-reload again. */
const GUARD_WINDOW_MS = 20_000;

/** sessionStorage is our loop-guard of choice; it can throw in locked-down
 *  privacy modes, so probe once and fall back to the URL param when it can't
 *  be used. */
function canUseSession(): boolean {
  try {
    const k = "__cr_probe";
    sessionStorage.setItem(k, "1");
    sessionStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** True when this document was loaded by a cache-busting reload we triggered. */
export function chunkReloadAttempted(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(CB_PARAM);
}

/**
 * Heuristic: does this error look like a failed lazy-chunk / dynamic-import
 * load (the stale-deploy class)? Covers the Chrome / Firefox / Safari phrasings
 * plus webpack-style ChunkLoadError, so it stays correct if the bundler changes.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  const name = e.name || "";
  const msg = e.message || "";
  return (
    name === "ChunkLoadError" ||
    /loading chunk [\w-]+ failed/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /dynamically imported module/i.test(msg)
  );
}

function replaceWithCacheBust(): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set(CB_PARAM, String(Date.now()));
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

/**
 * Auto-recovery entry point (called from the global vite:preloadError handler
 * and, as a backstop, from the ErrorBoundary). Triggers at most ONE cache-
 * busting reload; returns true if a reload was started (caller should stop its
 * own error handling — the page is navigating away), false if the guard
 * tripped (already tried once — show manual recovery instead).
 */
export function reloadForChunkError(): boolean {
  if (typeof window === "undefined") return false;

  if (canUseSession()) {
    const last = Number(sessionStorage.getItem(GUARD_KEY) || 0);
    if (last && Date.now() - last < GUARD_WINDOW_MS) return false; // already tried — don't loop
    try {
      sessionStorage.setItem(GUARD_KEY, String(Date.now()));
    } catch {
      /* ignore — proceed with a single reload */
    }
  } else if (chunkReloadAttempted()) {
    return false; // no sessionStorage: the cb param is our guard
  }

  replaceWithCacheBust();
  return true;
}

/**
 * User-initiated reload (the ErrorBoundary button). ALWAYS reloads with a fresh
 * cache-bust — no loop-guard, because a human tap is not an automatic loop and
 * they explicitly asked to retry with the freshest possible index.
 */
export function hardReload(): void {
  if (typeof window === "undefined") return;
  replaceWithCacheBust();
}

/**
 * After a successful load, drop our cache-bust param so it doesn't linger in
 * the address bar (or get bookmarked / shared on a lesson link). Only strips
 * when sessionStorage is available — otherwise the cb param IS the loop-guard
 * and must stay. Safe to call unconditionally on startup.
 */
export function stripChunkReloadParam(): void {
  if (typeof window === "undefined" || !window.history) return;
  if (!chunkReloadAttempted()) return;
  if (!canUseSession()) return; // cb is doing guard duty — keep it
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete(CB_PARAM);
    const qs = u.searchParams.toString();
    window.history.replaceState(
      window.history.state,
      "",
      u.pathname + (qs ? `?${qs}` : "") + u.hash,
    );
  } catch {
    /* cosmetic only — ignore */
  }
}
