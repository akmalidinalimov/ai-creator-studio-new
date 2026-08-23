import type { AuthChangeEvent, User } from "@supabase/supabase-js";

/**
 * True only for a GENUINE interactive sign-in — not a token refresh, a
 * tab-focus re-emit of SIGNED_IN, or a page-reload session restore
 * (INITIAL_SESSION, or SIGNED_IN with the same user we already saw).
 *
 * Used to gate one-time login side effects (new-student admin notification,
 * auth_events login log) so they don't fire on every refresh/focus, which
 * would spam admins and inflate the login count.
 */
export function isGenuineSignIn(
  event: AuthChangeEvent,
  prevUserId: string | null,
  nextUserId: string,
): boolean {
  return event === "SIGNED_IN" && prevUserId !== nextUserId;
}

/**
 * Choose the next `user` reference for AuthContext. Supabase hands us a brand-new
 * User object on EVERY auth event — including the hourly TOKEN_REFRESHED and the
 * SIGNED_IN re-emit that fires on tab-focus / Mini-App re-open. Returning that new
 * object each time churns every consumer keyed on `user` (e.g. LessonPage's
 * data-load effect), which was refetching progress and reloading the video
 * mid-playback. Keep the PREVIOUS reference when the identity is unchanged; swap
 * only on a real identity change (login / logout / different user) or an explicit
 * USER_UPDATED (email/metadata change, where the object's contents matter).
 */
export function stableUser(
  event: AuthChangeEvent,
  prev: User | null,
  next: User | null,
): User | null {
  if (event !== "USER_UPDATED" && prev && next && prev.id === next.id) return prev;
  return next;
}
