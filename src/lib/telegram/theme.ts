import type { TgWebApp } from "./types";

/**
 * "#0F766E" | "0f766e" → "174 78% 26%" — a space-separated HSL triplet in the exact
 * shape the app's CSS tokens use (consumed as `hsl(var(--token))`). Returns null for
 * anything that isn't a 6-digit hex so a malformed themeParam is skipped, not applied.
 */
function hexToHslTriplet(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// Telegram themeParam → app token(s). Foreground tokens track `text_color` so text stays
// legible on every surface we recolour (the classic "dark text on dark card" bug otherwise).
const TOKEN_MAP: Record<string, string[]> = {
  bg_color: ["--background"],
  secondary_bg_color: ["--card", "--popover", "--secondary", "--muted"],
  text_color: ["--foreground", "--card-foreground", "--popover-foreground", "--secondary-foreground"],
  hint_color: ["--muted-foreground"],
  button_color: ["--primary", "--accent"],
  button_text_color: ["--primary-foreground", "--accent-foreground"],
};

/**
 * Map Telegram's themeParams onto the app's design tokens so the Mini App wears the user's
 * Telegram theme (light/dark, custom themes). Guard: if `themeParams` is empty, no-op — the
 * app keeps its own palette. Re-run on the `themeChanged` event for live theme switches.
 */
export function applyTelegramTheme(webApp: TgWebApp): void {
  const tp = webApp.themeParams;
  if (!tp || Object.keys(tp).length === 0) return;
  const root = document.documentElement.style;
  for (const [tgKey, tokens] of Object.entries(TOKEN_MAP)) {
    const hex = tp[tgKey];
    if (!hex) continue;
    const hsl = hexToHslTriplet(hex);
    if (!hsl) continue;
    for (const token of tokens) root.setProperty(token, hsl);
  }
}
