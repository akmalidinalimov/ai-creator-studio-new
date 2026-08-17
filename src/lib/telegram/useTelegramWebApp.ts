import { useEffect, useState } from "react";
import type { TelegramNamespace, TgWebApp } from "./types";

/**
 * Detect + load the Telegram WebApp SDK. Generalized from the proven TgGroupBoard pattern:
 * if `window.Telegram.WebApp` is present, poll briefly for `initData`; otherwise inject
 * telegram-web-app.js then poll. Times out to "not in Telegram" (web mode).
 *
 * Returns `initData`:
 *   - `undefined` → still loading (show a spinner / gate)
 *   - `null`      → not inside Telegram (WEB MODE — render the app as normal)
 *   - `string`    → inside a Telegram Mini App
 */
export function useTelegramWebApp(): { webApp: TgWebApp | null; initData: string | null | undefined } {
  const [initData, setInitData] = useState<string | null | undefined>(undefined);
  const [webApp, setWebApp] = useState<TgWebApp | null>(null);

  useEffect(() => {
    let cancelled = false;
    const win = window as unknown as { Telegram?: TelegramNamespace; TelegramWebviewProxy?: unknown };
    const getWA = () => win.Telegram?.WebApp;
    const done = (wa: TgWebApp | null, data: string | null) => {
      if (cancelled) return;
      setWebApp(wa);
      setInitData(data);
    };

    // Cheap, synchronous gate so the PUBLIC WEBSITE stays a true no-op. Telegram Mini App
    // launches always carry `tgWebApp*` params in the URL (tgWebAppData/Version/Platform/…) and
    // mobile clients expose `TelegramWebviewProxy`. If neither is present we are a normal browser
    // → resolve web mode immediately and NEVER inject telegram.org's script (no 3rd-party request,
    // no spinner delay). Only a genuine Mini App context loads the SDK and polls for initData.
    const inTelegram =
      location.href.includes("tgWebApp") || !!win.TelegramWebviewProxy || !!getWA()?.initData;
    if (!inTelegram) {
      done(null, null);
      return () => { cancelled = true; };
    }

    const read = (attempts: number) => {
      if (cancelled) return;
      const wa = getWA();
      if (wa?.initData) {
        try { wa.ready(); } catch { /* ignore */ }
        return done(wa, wa.initData);
      }
      if (attempts <= 0) return done(wa ?? null, null);
      window.setTimeout(() => read(attempts - 1), 150);
    };

    if (getWA()) {
      read(20);
    } else {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js";
      s.async = true;
      s.onload = () => read(20);
      s.onerror = () => done(null, null);
      document.head.appendChild(s);
    }
    return () => { cancelled = true; };
  }, []);

  return { webApp, initData };
}
