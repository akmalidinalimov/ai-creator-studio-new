/**
 * trackVideoProgress — the ONE path for the per-tick `track_video_progress` RPC (LessonPage's native
 * <video> interval AND the Bunny player.js tick both call it every ~5s while a student watches).
 *
 * WHY: `supabase.rpc()` RESOLVES `{ data:null, error }` on an HTTP-level error (a 4xx/5xx from
 * PostgREST: the function was dropped/re-signatured, EXECUTE was revoked, a trigger raised, the JWT
 * was rejected …). The call sites only read `data?.completed`, so such an error was invisible —
 * watch time, resume position and auto-completion would stop recording and nobody would know until
 * students complained. Transport failures (fetch REJECTED, status 0) were already DB-visible: the
 * client's `beaconFetch` wrapper (src/integrations/supabase/client.ts) records them as
 * `backend_unreachable` with the RPC URL in `extra.url`. This module closes the other half.
 *
 * OUTCOMES (each classified exactly once, here):
 *  - ok                      → `{ ok:true, data }`, no beacon.
 *  - impersonation_readonly  → an admin previewing as a student. The RPC is NEVER CALLED (same rule
 *                              as `mutate()`), so the impersonation guard doesn't reject it — which
 *                              used to toast "Read-only" every 5s and orphan an unhandled rejection.
 *                              EXPECTED, never beaconed.
 *  - module_locked           → the RPC's own tier gate (`RAISE EXCEPTION 'module_locked'`). The page
 *                              already bounces a tier-locked student, so this means the client gate
 *                              and the server gate disagree — worth seeing, but it is NOT a broken
 *                              tracker. Beaconed under a DISTINCT message so it never reads as one.
 *  - network                 → status 0 (fetch rejected). Already beaconed as backend_unreachable →
 *                              not double-counted here.
 *  - error                   → anything else: beaconed `video_progress_rpc_failed:<class>`.
 *
 * Beacons fire at most ONCE per lesson per signal per page load (in-memory), so a tick that fails
 * every 5s produces one row, not hundreds. The message carries only a Postgres/PostgREST error CODE
 * or a fixed class slug — never the raw DB text, a token, or user data.
 */
import { supabase } from "@/integrations/supabase/client";
import { reportClientError } from "@/lib/beacon";
import { impersonatingReadonly, IMPERSONATION_RE } from "@/lib/mutate";

/** The jsonb `track_video_progress` returns (see the live function definition). */
export type VideoProgressData = {
  completed?: boolean;
  last_position_seconds?: number;
  max_position_seconds?: number;
  duration_seconds?: number | null;
};

export type VideoProgressFailReason = "impersonation_readonly" | "module_locked" | "network" | "error";

export type VideoProgressResult =
  | { ok: true; data: VideoProgressData | null }
  | { ok: false; reason: VideoProgressFailReason; cls: string };

type RpcErrorLike = { code?: unknown; message?: unknown } | null | undefined;

/** Beacon messages. `split_part(message, ':', 1)` groups them in client_error_events. */
export const VIDEO_PROGRESS_FAILED = "video_progress_rpc_failed";
export const VIDEO_PROGRESS_MODULE_LOCKED = "video_progress_module_locked";

// A short, fixed RAISE text like 'not authenticated' → 'not_authenticated'. Anything longer or with
// other characters (ids, quotes, dots — i.e. anything that could carry data) falls back to the code.
const SAFE_RAISE_TEXT = /^[a-z][a-z _-]{0,39}$/i;
const SAFE_CODE = /^[A-Za-z0-9]{2,12}$/;
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\./;

/**
 * Pure classifier for a `track_video_progress` error result. `status` is the PostgREST response
 * status (0 = the fetch itself rejected). Returns the outcome + a message-safe class string.
 */
export function classifyVideoProgressError(
  error: RpcErrorLike,
  status?: number | null,
): { reason: VideoProgressFailReason; cls: string } {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const code = typeof error?.code === "string" ? error.code.trim() : "";

  if (IMPERSONATION_RE.test(message)) return { reason: "impersonation_readonly", cls: "impersonation_readonly" };
  if (/^module_locked\b/.test(message)) return { reason: "module_locked", cls: "module_locked" };
  if (status === 0) return { reason: "network", cls: "network" };

  // P0001 = the function's own RAISE EXCEPTION: its fixed text is the useful class
  // ('not authenticated' → not_authenticated); the bare code would say nothing.
  if (code === "P0001" && SAFE_RAISE_TEXT.test(message)) {
    return { reason: "error", cls: message.toLowerCase().replace(/[\s-]+/g, "_") };
  }
  if (SAFE_CODE.test(code)) return { reason: "error", cls: code }; // e.g. PGRST202, 42883, 42501, PGRST303
  if (typeof status === "number" && status >= 400) return { reason: "error", cls: `http_${status}` }; // non-JSON body (proxy 502 …)
  return { reason: "error", cls: "unknown" };
}

// once per (signal, lesson) per page load
const beaconed = new Set<string>();

function beaconOnce(signal: string, lessonId: string, message: string, extra: Record<string, unknown>) {
  const key = `${signal}|${lessonId}`;
  if (beaconed.has(key)) return;
  beaconed.add(key);
  reportClientError({ type: "other", message, extra });
}

function safeDbMessage(error: RpcErrorLike): string | undefined {
  const m = typeof error?.message === "string" ? error.message : "";
  if (!m || TOKEN_SHAPE.test(m)) return undefined;
  return m.slice(0, 160);
}

/**
 * Record one progress tick. Never throws. Beacons a genuine failure (and, separately, a tier-lock
 * rejection) once per lesson per page load; an impersonation preview never calls the RPC at all.
 */
export async function trackVideoProgress(
  lessonId: string,
  p: { currentTime: number; duration: number; deltaSeconds: number },
): Promise<VideoProgressResult> {
  if (impersonatingReadonly()) return { ok: false, reason: "impersonation_readonly", cls: "impersonation_readonly" };

  let error: RpcErrorLike;
  let status: number | null;
  try {
    const res = await supabase.rpc("track_video_progress", {
      p_lesson_id: lessonId,
      p_current_time: p.currentTime,
      p_duration: p.duration,
      p_delta_seconds: p.deltaSeconds,
    });
    if (!res.error) return { ok: true, data: (res.data ?? null) as VideoProgressData | null };
    error = res.error;
    status = typeof res.status === "number" ? res.status : null;
  } catch (e) {
    // supabase-js doesn't throw on an HTTP error; the only rejection seen here is the impersonation
    // guard's (an impersonation toggle between the check above and the call). Anything else is a bug.
    const message = e instanceof Error ? e.message : String(e);
    if (IMPERSONATION_RE.test(message)) return { ok: false, reason: "impersonation_readonly", cls: "impersonation_readonly" };
    const cls = "exception";
    beaconOnce(VIDEO_PROGRESS_FAILED, lessonId, `${VIDEO_PROGRESS_FAILED}:${cls}`, { lessonId, cls });
    return { ok: false, reason: "error", cls };
  }

  const { reason, cls } = classifyVideoProgressError(error, status);
  if (reason === "module_locked") {
    beaconOnce(VIDEO_PROGRESS_MODULE_LOCKED, lessonId, VIDEO_PROGRESS_MODULE_LOCKED, { lessonId, status });
  } else if (reason === "error") {
    const code = typeof error?.code === "string" ? error.code : undefined;
    beaconOnce(VIDEO_PROGRESS_FAILED, lessonId, `${VIDEO_PROGRESS_FAILED}:${cls}`, {
      lessonId, cls, code, status, dbMessage: safeDbMessage(error),
    });
  }
  // impersonation_readonly: expected no-op. network: already beaconed as backend_unreachable.
  return { ok: false, reason, cls };
}
