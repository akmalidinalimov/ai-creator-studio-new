// Single source of truth for the canonical site URL on the client.
// Order: explicit VITE_SITE_URL → window.location.origin (browser) → apex production fallback.
const FALLBACK = "https://aicreator.academy";

export function getSiteUrl(): string {
  const env = (import.meta as any).env?.VITE_SITE_URL as string | undefined;
  if (env && env.trim()) return env.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/$/, "");
  }
  return FALLBACK;
}
