// The rating's own points for a CONTENT-ONLY course (Challenge 6.0: points earned before 2026-10-08 are kept, after it
// only lessons + homework add — platform_settings.rating_mode) — read from public.rating_points(uid), the one source the home screen, the Profil
// screen and the bot all use. For every other course it is null and the screens keep lifetime XP exactly as before.

export type ContentRating = { points: number; week: number | null };

/** Parse a rating_points() RPC result. Null = not a content-only course (or no group / no row). Pure. */
export function readContentRating(res: { data?: unknown; error?: unknown } | null | undefined): ContentRating | null {
  if (!res || res.error) return null;
  const row: any = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!row || row.content_only !== true || typeof row.points !== "number") return null;
  return { points: row.points, week: typeof row.week_points === "number" ? row.week_points : null };
}

/** The error code to beacon for a failed rating_points() read, or null when it did not fail. Pure. */
export function contentRatingError(res: { error?: any } | null | undefined): string | null {
  const e = res?.error;
  return e ? String(e.code || e.message || "error") : null;
}
