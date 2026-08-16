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
    const getWA = () => (window as unknown as { Telegram?: TelegramNamespace }).Telegram?.WebApp;
    const done = (wa: TgWebApp | null, data: string | null) => {
      if (cancelled) return;
      setWebApp(wa);
      setInitData(data);
    };
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
