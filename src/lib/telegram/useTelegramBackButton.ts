import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { TgWebApp } from "./types";

// Screens that are "home" — the native back button is hidden here (nowhere to go back to).
const ROOT_PATHS = new Set<string>(["/", "/dashboard", "/admin/dashboard"]);

/**
 * Wire Telegram's native header BackButton to the router: show it on any non-root screen and
 * pop history when tapped; hide it on the roots. No-op in web mode (`webApp === null`).
 *
 * Must be mounted inside the Router (it reads `useLocation`/`useNavigate`).
 */
export function useTelegramBackButton(webApp: TgWebApp | null): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const bb = webApp?.BackButton;
    if (!bb) return;

    const onClick = () => navigate(-1);
    if (ROOT_PATHS.has(location.pathname)) {
      bb.hide();
    } else {
      bb.show();
      bb.onClick(onClick);
    }
    return () => { bb.offClick(onClick); };
  }, [webApp, location.pathname, navigate]);
}
