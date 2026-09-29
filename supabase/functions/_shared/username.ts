// Telegram usernames contain "_", which is a single-character WILDCARD in SQL LIKE/ILIKE. An
// unescaped `.ilike("telegram_username", name)` is therefore NOT an exact match: "a_ice1" matches the
// profile "alice1". On the first-time username→profile link paths (website login, bot /start, Mini App)
// that let a Telegram user pick a username that claims a DIFFERENT unlinked student's account.
// Always pass the value through likeEscape(); the footgun lint (eslint.footguns.config.js) enforces it.

/** Escape LIKE metacharacters (\ % _) so the value matches literally. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Canonical form for comparing usernames: no leading "@", trimmed, lowercase. */
export function normUsername(u: string | null | undefined): string {
  return String(u ?? "").trim().replace(/^@+/, "").toLowerCase();
}
