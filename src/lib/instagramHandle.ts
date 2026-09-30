/**
 * Instagram handle parsing — the client twin of the DB function `public.instagram_handle_parse(text)`
 * (migration 20260930154000_instagram_handle_parse.sql), which `normalize_instagram_username()` runs on
 * every write of profiles.instagram_username.
 *
 * WHY IT EXISTS. Challenge 6.0 matches a student's verified Instagram post back to them by this handle
 * (Instagram tasks are worth real points), and the field failed silently in three ways:
 *   - a handle with a space / Cyrillic letters was dropped by the DB trigger (old value kept) while the
 *     page still said "Saqlandi";
 *   - a pasted post/reel link was stored as its first path segment — "reel" or "p" — so the first
 *     student to paste a reel owned the handle "reel" and every later one hit a raw unique-index error;
 *   - "https://instagram.com/" (no handle) CLEARED an existing handle.
 * Validating here gives the student an Uzbek message before anything is sent, and the page then sends
 * the NORMALIZED handle, so the DB parse is idempotent on it. The DB keeps the same rules as the
 * backstop for every other writer (staff intake, stale Mini App builds) and records each refusal in
 * admin_actions ('instagram_handle_rejected').
 *
 * PARITY: the reserved path segments and the rules below must match the SQL function exactly.
 * src/test/instagramHandle.test.ts reads the migration and fails if the reserved list or any of its
 * self-test cases disagree with this file.
 */

/** First path segments of instagram.com that are pages, not profiles (a post, a reel, a story...). */
export const INSTAGRAM_RESERVED_SEGMENTS: readonly string[] = [
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "share", "s",
  "about", "legal", "developer", "web",
];

const RESERVED = new Set(INSTAGRAM_RESERVED_SEGMENTS);

export const INSTAGRAM_HANDLE_MAX = 30;

export type InstagramRejectReason =
  | "not_profile_link"   // an instagram.com link to a post / reel / story / other page
  | "no_handle_in_link"  // "instagram.com" or "https://instagram.com/" with no handle after it
  | "empty"              // only "@" characters
  | "too_long"           // more than 30 characters
  | "bad_chars";         // anything but a-z, 0-9, "." and "_" (spaces, Cyrillic, "-", other links)

export type InstagramParse =
  | { ok: true; handle: string | null }   // null = the field was left blank: clear the handle
  | { ok: false; reason: InstagramRejectReason };

export const INSTAGRAM_REJECT_REASONS: readonly InstagramRejectReason[] = [
  "not_profile_link", "no_handle_in_link", "empty", "too_long", "bad_chars",
];

/** Strip leading/trailing whitespace, including the invisible characters a mobile paste carries. */
function trimAll(s: string): string {
  return s.replace(/^[\s​-‍﻿]+|[\s​-‍﻿]+$/g, "");
}

/**
 * Parse what a person typed or pasted into the Instagram field.
 *   "@My.Handle"                                   -> ok "my.handle"
 *   "https://www.instagram.com/my.handle/?igsh=x"  -> ok "my.handle"
 *   ""  /  "   "                                   -> ok null (clear)
 *   "https://www.instagram.com/reel/C8xYz12/"      -> not_profile_link
 *   "my handle" / "алишер" / "my-handle"           -> bad_chars
 */
export function parseInstagramHandle(input: string | null | undefined): InstagramParse {
  let v = trimAll(String(input ?? "")).toLowerCase();
  if (v === "") return { ok: true, handle: null };

  if (v.includes("instagram.com/")) {
    let seg = v.split("instagram.com/")[1] ?? "";
    seg = seg.split("?")[0].split("#")[0].split("/")[0];
    if (RESERVED.has(seg)) return { ok: false, reason: "not_profile_link" };
    if (seg === "") return { ok: false, reason: "no_handle_in_link" };
    v = seg;
  } else if (v.includes("instagram.com")) {
    return { ok: false, reason: "no_handle_in_link" };
  }

  v = trimAll(v.replace(/^@+/, ""));
  if (v === "") return { ok: false, reason: "empty" };
  if (v.length > INSTAGRAM_HANDLE_MAX) return { ok: false, reason: "too_long" };
  if (!/^[a-z0-9._]+$/.test(v)) return { ok: false, reason: "bad_chars" };
  return { ok: true, handle: v };
}

/** The unique index a second account with the same handle trips (Postgres 23505). */
export const INSTAGRAM_UNIQUE_INDEX = "uq_profiles_instagram_username";

/** True when a save failed because another profile already has this handle. */
export function isInstagramHandleTaken(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const msg = String(err.message ?? "");
  return msg.includes(INSTAGRAM_UNIQUE_INDEX) || (err.code === "23505" && /instagram/i.test(msg));
}
