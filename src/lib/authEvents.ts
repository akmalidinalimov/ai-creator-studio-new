import type { AuthChangeEvent } from "@supabase/supabase-js";

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
