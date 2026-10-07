import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { TgWebApp } from "./types";
import { parentOf } from "./landing";

// Screens that are "home" — the native back button is hidden here (nowhere to go back to).
const ROOT_PATHS = new Set<string>(["/", "/dashboard", "/admin/dashboard", "/tg/teacher"]);

/**
 * What the native Back button does on `pathname`. With in-app history (history.state.idx > 0) it pops one
 * entry, as before. On a COLD deep-link entry (a watch button opened /lesson/… directly: idx is 0 or missing)
 * navigate(-1) would do nothing, so it goes to the screen's parent instead (lesson → its course → dashboard).
 * Exported for the unit test.
 */
export function backTarget(pathname: string, historyState: unknown): number | string {
  const idx = (historyState as { idx?: unknown } | null | undefined)?.idx;
  const cold = idx === undefined || idx === null || idx === 0;
  if (!cold) return -1;
  return parentOf(pathname) ?? -1;
}

// An open overlay (a dialog / sheet with its own steps) takes over the native ← while it is open: the newest one wins.
// Without it, Telegram's ← left the whole page from inside the homework upload sheet (2026-10-07).
const overrides: Array<() => void> = [];

/** Register a handler for the native ←; returns the unregister function. Exported for the unit test. */
export function pushTelegramBackOverride(fn: () => void): () => void {
  overrides.push(fn);
  return () => {
    const i = overrides.lastIndexOf(fn);
    if (i >= 0) overrides.splice(i, 1);
  };
}

/** The handler that runs on the native ←, if an overlay holds it. Exported for the unit test. */
export function activeTelegramBackOverride(): (() => void) | null {
  return overrides.length ? overrides[overrides.length - 1] : null;
}

/** While `active`, the native ← calls `handler` (the latest one) instead of navigating. No-op on the web. */
export function useTelegramBackOverride(active: boolean, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushTelegramBackOverride(() => ref.current());
  }, [active]);
}

/**
 * Wire Telegram's native header BackButton to the router: show it on any non-root screen and
 * go back when tapped; hide it on the roots. No-op in web mode (`webApp === null`).
 *
 * Must be mounted inside the Router (it reads `useLocation`/`useNavigate`).
 */
export function useTelegramBackButton(webApp: TgWebApp | null): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const bb = webApp?.BackButton;
    if (!bb) return;

    const onClick = () => {
      const override = activeTelegramBackOverride();
      if (override) { override(); return; }
      const target = backTarget(location.pathname, typeof window !== "undefined" ? window.history.state : null);
      if (typeof target === "number") navigate(target);
      else navigate(target, { replace: true });
    };
    if (ROOT_PATHS.has(location.pathname)) {
      bb.hide();
    } else {
      bb.show();
      bb.onClick(onClick);
    }
    return () => { bb.offClick(onClick); };
  }, [webApp, location.pathname, navigate]);
}
