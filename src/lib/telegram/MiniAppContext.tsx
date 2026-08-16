import { createContext, useContext, type ReactNode } from "react";
import type { TgWebApp } from "./types";
import { useTelegramWebApp } from "./useTelegramWebApp";

interface MiniAppState {
  /** True once we've confirmed we're running inside a Telegram Mini App. */
  isMiniApp: boolean;
  webApp: TgWebApp | null;
  /** undefined = still detecting, null = web mode, string = in Telegram. */
  initData: string | null | undefined;
}

const MiniAppCtx = createContext<MiniAppState>({ isMiniApp: false, webApp: null, initData: null });

/**
 * Runs the Telegram WebApp detection ONCE at the app root and provides it to the tree.
 * `TelegramGate` (and any component) reads it via `useMiniApp()` — no double SDK load.
 */
export function MiniAppProvider({ children }: { children: ReactNode }) {
  const { webApp, initData } = useTelegramWebApp();
  return (
    <MiniAppCtx.Provider value={{ isMiniApp: typeof initData === "string", webApp, initData }}>
      {children}
    </MiniAppCtx.Provider>
  );
}

export function useMiniApp(): MiniAppState {
  return useContext(MiniAppCtx);
}
