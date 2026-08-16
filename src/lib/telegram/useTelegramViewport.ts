import { useEffect } from "react";
import type { TgWebApp } from "./types";

/**
 * Make the Mini App fill the Telegram viewport and behave like a real app:
 *   - `ready()` + `expand()` so it opens full-height (not the small default sheet).
 *   - publish `--tg-viewport-stable-height` and safe-area insets as CSS vars for layout.
 *   - `disableVerticalSwipes()` on Bot API ≥ 7.7 so a downward scroll doesn't close the app.
 *
 * No-op in web mode (`webApp === null`). All SDK calls are guarded — older Telegram clients
 * that lack a method simply skip it.
 */
export function useTelegramViewport(webApp: TgWebApp | null): void {
  useEffect(() => {
    if (!webApp) return;

    try { webApp.ready(); } catch { /* ignore */ }
    try { webApp.expand(); } catch { /* ignore */ }
    if (webApp.isVersionAtLeast?.("7.7")) {
      try { webApp.disableVerticalSwipes?.(); } catch { /* ignore */ }
    }

    const root = document.documentElement.style;
    const apply = () => {
      const h = webApp.viewportStableHeight;
      if (h && h > 0) root.setProperty("--tg-viewport-stable-height", `${h}px`);
      const inset = webApp.contentSafeAreaInset || webApp.safeAreaInset;
      if (inset) {
        root.setProperty("--tg-safe-area-top", `${inset.top}px`);
        root.setProperty("--tg-safe-area-bottom", `${inset.bottom}px`);
        root.setProperty("--tg-safe-area-left", `${inset.left}px`);
        root.setProperty("--tg-safe-area-right", `${inset.right}px`);
      }
    };
    apply();

    webApp.onEvent?.("viewportChanged", apply);
    webApp.onEvent?.("safeAreaChanged", apply);
    webApp.onEvent?.("contentSafeAreaChanged", apply);
    return () => {
      webApp.offEvent?.("viewportChanged", apply);
      webApp.offEvent?.("safeAreaChanged", apply);
      webApp.offEvent?.("contentSafeAreaChanged", apply);
    };
  }, [webApp]);
}
