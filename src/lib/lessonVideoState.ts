// Which screen a lesson-video-url answer means (LessonPage).
//
// Before 2026-10-04 EVERY failure showed "Bu dars sizning tarifingizda mavjud emas" ("not in your plan"). A student
// on a flaky connection (73 backend_unreachable beacons from 36 students in one day, mostly in the Telegram Mini
// App) was told a module-1 lesson was outside her plan when the request simply never arrived.
//
// Only a 403 is the server's access verdict (module_locked / provisional_locked / forbidden). Anything else (no
// network, a 5xx, a 401, an empty body) is a LOAD FAILURE: the student is told to check the connection and retry.
export type VideoFetchOutcome = "ok" | "locked" | "failed";

/** supabase.functions.invoke's { data, error } → the outcome. FunctionsHttpError carries the Response in .context. */
export function videoFetchOutcome(error: unknown, data: unknown): VideoFetchOutcome {
  if (!error) return data ? "ok" : "failed";
  const status = (error as { context?: { status?: unknown } } | null)?.context?.status;
  return status === 403 ? "locked" : "failed";
}

/** The HTTP status of a failed invoke, when there was one (for the beacon). */
export function videoFetchStatus(error: unknown): number | null {
  const status = (error as { context?: { status?: unknown } } | null)?.context?.status;
  return typeof status === "number" ? status : null;
}

export type VideoLock = { code: "not_member" | "locked"; joinUrl: string | null };

/** The 403 body → which lock. 'not_member' (20261030145000): the student left the course's Telegram channel and groups —
 *  shown as "rejoin" with the channel link, never as "not in your plan". Anything unreadable is the plain lock. */
export function videoLockOf(body: unknown): VideoLock {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; join_url?: unknown };
  if (b.error === "not_member") {
    const url = typeof b.join_url === "string" && /^https:\/\/t\.me\//.test(b.join_url) ? b.join_url : null;
    return { code: "not_member", joinUrl: url };
  }
  return { code: "locked", joinUrl: null };
}

/** Read the JSON body of a FunctionsHttpError's Response (once; null when there is none). */
export async function videoErrorBody(error: unknown): Promise<unknown> {
  const ctx = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  try { return ctx && typeof ctx.json === "function" ? await ctx.json() : null; } catch { return null; }
}
