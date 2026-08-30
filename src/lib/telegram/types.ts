// Minimal typing for the parts of the Telegram WebApp SDK we use (window.Telegram.WebApp).
// Full SDK: https://core.telegram.org/bots/webapps

export interface TgBackButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TgSafeAreaInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TgWebApp {
  initData: string;
  version: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  safeAreaInset?: TgSafeAreaInset;
  contentSafeAreaInset?: TgSafeAreaInset;
  BackButton: TgBackButton;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  /** Open a t.me/telegram.org link inside Telegram (the reliable way to reach a private topic link
   *  from the Mini App — a plain <a> can silently no-op in some clients). */
  openTelegramLink?(url: string): void;
  /** Open an external http(s) link (optionally in the in-app browser). */
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
}

export interface TelegramNamespace {
  WebApp?: TgWebApp;
}
