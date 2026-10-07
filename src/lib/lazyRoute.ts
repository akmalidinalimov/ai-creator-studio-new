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

type Module<T> = { default: T };

export function makeLazyRouteLoader<T extends ComponentType<any>>(
  factory: () => Promise<Module<T>>,
  deps: { reload: () => boolean; heal: (url: string | null) => Promise<void> } = {
    reload: reloadForChunkError,
    heal: (url) => healCachedAsset(url),
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
