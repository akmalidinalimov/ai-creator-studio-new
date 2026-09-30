// A broadcast button that points at OUR site (e.g. https://aicreator.academy/lessons) opens in Telegram's
// built-in browser, logged out. When the student Mini App is on, such a button becomes a web_app button to
// the same path, so it opens inside the Mini App, signed in. Any other url (Instagram, a form, …) is untouched.

/** The path (+query) of `url` when its origin is one of `siteOrigins`, else null. Pure. */
export function siteButtonPath(url: string | null | undefined, siteOrigins: Iterable<string>): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const origins = new Set<string>();
  for (const o of siteOrigins) {
    try {
      origins.add(new URL(o).origin);
    } catch { /* skip a malformed origin */ }
  }
  if (!origins.has(u.origin)) return null;
  // A magic link is a one-time login for ONE student — never re-wrap it (it would open the Mini App at the
  // redeem page). Broadcasts do not carry them today; this keeps it that way.
  if (u.pathname.startsWith("/auth/")) return null;
  return (u.pathname || "/") + u.search;
}
