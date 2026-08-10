/**
 * Runtime platform detection.
 *
 * Shared by the video-protection layer (anti-piracy heuristics must not fight mobile playback)
 * and, later, the Telegram Mini App wiring. Kept dependency-free and SSR-safe.
 */

/** True on phones/tablets and any coarse-pointer device. */
export function isTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const touchPoints = (navigator.maxTouchPoints ?? 0) > 0;
  const coarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return touchPoints || coarse;
}

/** Best-effort detection of Telegram's Mini App / in-app webview. */
export function isTelegramWebView(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { Telegram?: { WebApp?: { initData?: string } } };
  const hasWebApp = Boolean(w.Telegram?.WebApp?.initData);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
  return hasWebApp || /Telegram/i.test(ua);
}
