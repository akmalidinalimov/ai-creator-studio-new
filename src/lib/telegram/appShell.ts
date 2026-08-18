import type { TgWebApp } from "./types";

/** Match Telegram's native header/background to the brand ground so its chrome doesn't clash. */
export function applyTelegramChrome(webApp: TgWebApp): void {
  const isDark = document.documentElement.classList.contains("dark");
  const bg = isDark ? "#15191B" : "#F2F4F3";
  try { (webApp as any).setBackgroundColor?.(bg); } catch { /* older client */ }
  try { (webApp as any).setHeaderColor?.(bg); } catch { /* older client */ }
}
