import { lazy, type ComponentType } from "react";
import { isChunkLoadError, reloadForChunkError } from "@/lib/chunkReload";

/**
 * React.lazy for a route, with stale-deploy recovery that never shows the crash screen when it can recover.
 *
 * 2026-10-07 incident (@usmanly_x and others, "Nimadir noto'g'ri ketdi" in the Mini App): after a deploy, a route chunk
 * could not be loaded. Two things made it stick:
 *   1. the chunk URL's HTTP cache entry was POISONED — the old vercel.json rewrote a missing /assets/* file to index.html
 *      (200, text/html) with the /assets/ "immutable, 1 year" header, so the webview kept answering every retry and
 *      every reload from that cached HTML ("'text/html' is not a valid JavaScript MIME type");
 *   2. the vite:preloadError handler called preventDefault, which makes the import RESOLVE TO undefined, so React.lazy
 *      crashed on `.default` (the render_crash "Cannot read properties of undefined (reading 'default')").
 * Here: a failed (or empty) chunk is re-fetched with cache: "reload" — that REPLACES the poisoned HTTP-cache entry —
 * then ONE guarded cache-busting reload pulls the current build. While the page reloads, the Suspense fallback stays
 * up (a never-settling promise) instead of the crash screen. Only when the loop guard trips does the error reach the
 * ErrorBoundary's manual recovery.
 */

/** The .js / .css URL inside a dynamic-import error message ("Failed to fetch dynamically imported module: <url>"). */
export function chunkUrlFrom(err: unknown): string | null {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? "");
  const m = /(https?:\/\/[^\s'"]+?\.(?:js|css))(?:[?#][^\s'"]*)?(?=[\s'"]|$)/i.exec(msg);
  return m ? m[1] : null;
}

/** Refresh one cached asset from the network (overwrites a poisoned cache entry). Never throws. */
export async function healCachedAsset(url: string | null, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await fetchFn(url, { cache: "reload", credentials: "same-origin" });
  } catch {
    /* offline / blocked: the reload below still tries the current build */
  }
}

/**
 * Every /assets/ file this page has loaded or preloads (performance entries, module scripts, modulepreload links) —
 * WebKit's error names no file, and the poisoned file may be a SHARED chunk, not the route's own.
 */
export function cachedAssetUrls(): string[] {
  const out = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (!u) return;
    try {
      const url = new URL(u, window.location.href);
      if (url.origin === window.location.origin && /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)) out.add(url.origin + url.pathname);
    } catch { /* not a URL */ }
  };
  try { for (const e of performance.getEntriesByType("resource")) add(e.name); } catch { /* no timing API */ }
  try {
    document.querySelectorAll<HTMLScriptElement>("script[type=module][src]").forEach((s) => add(s.src));
    document.querySelectorAll<HTMLLinkElement>("link[rel=modulepreload][href], link[rel=stylesheet][href]").forEach((l) => add(l.href));
  } catch { /* no DOM */ }
  return [...out].slice(0, 120);
}

/**
 * Re-fetch every cached asset that is NOT what it claims to be (HTML, or an error) with cache: "reload". Reads go
 * through the HTTP cache first (cheap); only a poisoned entry costs a network request. Never throws.
 */
export async function healPoisonedAssets(urls: string[] = cachedAssetUrls(), fetchFn: typeof fetch = fetch): Promise<number> {
  let healed = 0;
  for (const u of urls) {
    try {
      const r = await fetchFn(u, { cache: "force-cache", credentials: "same-origin" });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!r.ok || ct.includes("text/html")) {
        await fetchFn(u, { cache: "reload", credentials: "same-origin" });
        healed++;
      }
    } catch { /* offline: the reload still tries */ }
  }
  return healed;
}

type Module<T> = { default: T };

export function makeLazyRouteLoader<T extends ComponentType<any>>(
  factory: () => Promise<Module<T>>,
  deps: { reload: () => boolean; heal: (url: string | null) => Promise<void> } = {
    reload: reloadForChunkError,
    // the failed file when the browser names it; otherwise (WebKit) every cached asset that turned out to be HTML
    heal: async (url) => { if (url) await healCachedAsset(url); else await healPoisonedAssets(); },
  },
): () => Promise<Module<T>> {
  return async () => {
    let err: unknown;
    try {
      const m = await factory();
      if (m && m.default) return m;
      // an import that resolved to nothing (a prevented vite:preloadError) is a failed chunk too
      err = new Error("Failed to fetch dynamically imported module (empty module)");
    } catch (e) {
      if (!isChunkLoadError(e)) throw e; // a real code error: the ErrorBoundary shows it
      err = e;
    }
    await deps.heal(chunkUrlFrom(err));
    if (deps.reload()) {
      return new Promise<Module<T>>(() => {}); // navigating away: keep the Suspense fallback, never the crash screen
    }
    throw err; // the loop guard tripped: manual recovery in the ErrorBoundary
  };
}

export function lazyRoute<T extends ComponentType<any>>(factory: () => Promise<Module<T>>) {
  return lazy(makeLazyRouteLoader(factory));
}
