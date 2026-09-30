// miniapp-links — ONE route grammar for every student button that opens the Mini App to watch:
//
//   private chat  → inline {web_app:{url: BASE + withTrack(path, {src, ref})}}        (signed initData)
//   group chat    → {url: "https://t.me/<bot>/app?startapp=" + encodeStartParam(...)}  (named Mini App)
//
//   continuePath()           "/continue"            → the student's next unfinished lesson (primary course)
//   continuePath(c)          "/continue/<c>"        → the next unfinished lesson in course c
//   lessonPath(c, l)         "/lesson/<c>/<l>"      → that lesson (the player resumes where they stopped)
//   coursePath(c)            "/course/<c>"          → the course page (the trial card for a provisional student)
//
//   start_param              path
//   "c"                      /continue
//   "c_<course uuid>"        /continue/<course uuid>
//   "l_<lesson uuid>"        /continue?lesson=<lesson uuid>   (the page checks enrolment + tier before opening it)
//   "hw" | "homework"        /homework
//   "leaderboard"            /leaderboard
//   "profile"                /profile
//   any of them + "__<src>"  the same path; <src> is the open-signal source (MINIAPP_SRCS)
//
// startParamToPath is WHITELIST-ONLY: every id must be a UUID and every other value is a fixed literal, so no
// start_param can ever produce an open redirect ("//evil", "https://x", "/\\x" all map to null).
//
// Pure: no imports, no Deno or DOM APIs (URLSearchParams exists in both). The SAME FILE, byte for byte, is
//   supabase/functions/_shared/miniapp-links.ts   (edge functions + the bot)
//   src/lib/miniappLinks.ts                       (the web / Mini App bundle, which cannot import supabase/functions)
// src/test/miniapp-links-parity.test.ts fails if the two copies drift. Edit one, copy it over the other.

/** Where a watch button came from — the open signal (admin_actions 'miniapp_open') is counted per source. */
export const MINIAPP_SRCS = [
  "daily_reminder",
  "streak_warning",
  "drip_3",
  "drip_7",
  "drip_14",
  "drip_30",
  "nudge_3d",
  "nudge_7d",
  "nudge_module",
  "nudge_stuck",
  "bot_davom",
  "bot_dars",
  "bot_welcome",
  "teacher_nudge",
  // Staff buttons into the TEACHER Mini App (_shared/teacher-miniapp.ts) — counted the same way:
  "teacher_hw_dm", //        🎯 Baholash on the new-homework DM (ref = the submission)
  "teacher_hw_reminder", //  🎯 Baholash on the 24 h ungraded reminder (ref = the submission)
  "teacher_report", //       the daily report's 📝 Baholash (N) / 👤 Profil
  "teacher_card", //         the bot's 👤 Profil card (📊 Statistika / 📣 Guruhga xabar)
  "reengagement",
  "broadcast",
  "daily_task",
] as const;
export type MiniAppSrc = (typeof MINIAPP_SRCS)[number];

const SRC_SET: ReadonlySet<string> = new Set<string>(MINIAPP_SRCS);

export function isMiniAppSrc(s: unknown): s is MiniAppSrc {
  return typeof s === "string" && SRC_SET.has(s);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Telegram's startapp limit and alphabet. */
export const START_PARAM_MAX = 512;
const START_PARAM_RE = /^[A-Za-z0-9_-]+$/;

// ─────────────────────────── paths ───────────────────────────

/** "/continue" or "/continue/<course uuid>". A missing or non-UUID course id gives the bare "/continue". */
export function continuePath(courseId?: string | null): string {
  return isUuid(courseId) ? `/continue/${courseId.toLowerCase()}` : "/continue";
}

/** "/lesson/<c>/<l>". Ids that are not UUIDs degrade to continuePath(c) — never a malformed lesson URL. */
export function lessonPath(courseId: string, lessonId: string): string {
  if (isUuid(courseId) && isUuid(lessonId)) return `/lesson/${courseId.toLowerCase()}/${lessonId.toLowerCase()}`;
  return continuePath(courseId);
}

/** "/course/<c>". A non-UUID course id degrades to "/dashboard". */
export function coursePath(courseId: string): string {
  return isUuid(courseId) ? `/course/${courseId.toLowerCase()}` : "/dashboard";
}

export type WatchTrack = { src: MiniAppSrc; ref?: string | null };

/**
 * Append ?src=<src>&ref=<ref> (or &src=… when the path already has a query). An unknown src leaves the path
 * unchanged; a ref that is not a UUID is dropped. The Mini App reads these once, reports the open, and strips them.
 */
export function withTrack(path: string, track: WatchTrack): string {
  if (!isMiniAppSrc(track?.src)) return path;
  const parts = [`src=${track.src}`];
  if (isUuid(track.ref)) parts.push(`ref=${track.ref.toLowerCase()}`);
  return path + (path.includes("?") ? "&" : "?") + parts.join("&");
}

/** The validated {src, ref} of a URL query ("?src=…&ref=…"), or null when there is no known src. */
export function readTrack(search: string): { src: MiniAppSrc; ref: string | null } | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search || "");
  } catch {
    return null;
  }
  const src = q.get("src");
  if (!isMiniAppSrc(src)) return null;
  const ref = q.get("ref");
  return { src, ref: isUuid(ref) ? ref.toLowerCase() : null };
}

/** The query string without src/ref ("" when nothing is left, else "?…"). */
export function stripTrack(search: string): string {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search || "");
  } catch {
    return "";
  }
  q.delete("src");
  q.delete("ref");
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ─────────────────────────── start_param (named Mini App direct links) ───────────────────────────

export type NamedStart = "hw" | "homework" | "leaderboard" | "profile";
export type StartTarget = "continue" | NamedStart | { courseId: string | null | undefined } | { lessonId: string };

const NAMED: Record<NamedStart, string> = {
  hw: "/homework",
  homework: "/homework",
  leaderboard: "/leaderboard",
  profile: "/profile",
};

/**
 * The start_param for a t.me/<bot>/app?startapp= link: "c", "c_<course>", "l_<lesson>", "hw", "homework",
 * "leaderboard" or "profile", plus "__<src>" when a known src is given. A non-UUID id degrades to "c".
 */
export function encodeStartParam(target: StartTarget, src?: MiniAppSrc | null): string {
  let head = "c";
  if (typeof target === "string") {
    head = target === "continue" ? "c" : (Object.prototype.hasOwnProperty.call(NAMED, target) ? target : "c");
  } else if (target && "lessonId" in target) {
    head = isUuid(target.lessonId) ? `l_${target.lessonId.toLowerCase()}` : "c";
  } else if (target && "courseId" in target) {
    head = isUuid(target.courseId) ? `c_${target.courseId.toLowerCase()}` : "c";
  }
  const p = isMiniAppSrc(src) ? `${head}__${src}` : head;
  return p.length <= START_PARAM_MAX && START_PARAM_RE.test(p) ? p : "c";
}

/**
 * Map a start_param to an in-app path. Whitelist-only: returns null for anything that is not exactly one of the
 * forms encodeStartParam produces (so it can never yield an external or protocol-relative URL). An unknown
 * "__<src>" suffix is ignored (src null); the path still maps.
 */
export function startParamToPath(p: string | null | undefined): { path: string; src: MiniAppSrc | null } | null {
  if (typeof p !== "string" || p.length === 0 || p.length > START_PARAM_MAX || !START_PARAM_RE.test(p)) return null;
  const cut = p.indexOf("__");
  const head = cut >= 0 ? p.slice(0, cut) : p;
  const tail = cut >= 0 ? p.slice(cut + 2) : null;
  const src = isMiniAppSrc(tail) ? tail : null;
  if (head === "c") return { path: "/continue", src };
  if (Object.prototype.hasOwnProperty.call(NAMED, head)) return { path: NAMED[head as NamedStart], src };
  if (head.startsWith("c_") && isUuid(head.slice(2))) return { path: `/continue/${head.slice(2).toLowerCase()}`, src };
  if (head.startsWith("l_") && isUuid(head.slice(2))) return { path: `/continue?lesson=${head.slice(2).toLowerCase()}`, src };
  return null;
}

/** The start_param Telegram signed into initData ("" / missing → null). Never throws. */
export function startParamFromInitData(initData: string | null | undefined): string | null {
  if (!initData) return null;
  try {
    return new URLSearchParams(initData).get("start_param") || null;
  } catch {
    return null;
  }
}
