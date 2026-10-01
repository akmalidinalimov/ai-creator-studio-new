// miniapp-button — the ONE helper every sender uses to build a student "watch" button.
//
// WHY: every daily reminder, streak warning, drip, nudge and bot reply used to carry a MAGIC-LINK url button.
// A url button opens Telegram's in-app browser (not the Mini App): no signed initData, a one-time token that
// expires (7 days; 24 h for nudges), a stale lesson id frozen at send time, and a browser session that is not
// the Mini App's. Owner 2026-09-30: "once clicked it should go through the Mini App". So:
//
//   private chat + flag on   → {text, web_app:{url: MINIAPP_BASE + withTrack(miniPath, track)}}   mode 'web_app'
//   group chat   + flag on   → {text, url: MINIAPP_DIRECT + '?startapp=' + encodeStartParam(...)}  mode 'startapp'
//   private chat + flag off  → await magicLink(legacyPath) — today's exact button (byte-identical) mode 'magic_link'
//   group chat   + flag off  → NO button (never a magic link in a group: it would log ANYONE who taps it into
//                               that one student's account). The types refuse a magicLink for chat:'group'.
//
// Kill-switches (platform_settings.student_miniapp, 60 s cache, FAIL-CLOSED like the webhook's reader):
//   enabled !== true              → everything reverts to today's magic links (private) / no button (group)
//   watch_buttons === false       → only the notification buttons revert; the 🚀 Ilovani ochish entry stays
// Every fallback is counted (the returned `reason`), and the two that mean "broken" are alarmed:
//   bad_base  → logHealthOnce('miniapp_button_fallback')     (MINIAPP_BASE / MINIAPP_DIRECT_LINK malformed)
//   rejected  → logHealthOnce('miniapp_button_rejected')     (Telegram refused a web_app button; resent once)
// Those two rows raise the STUDENT watch-button alarm (watch_button_health, any fn). A button into the TEACHER
// Mini App (/tg/teacher…, _shared/teacher-miniapp.ts) is built by the same code, so its faults are written as
// 'teacher_miniapp_button_fallback' / 'teacher_miniapp_button_rejected' — derived from the button's own path
// (BUTTON_FAULT_ACTIONS, webAppAudience), never passed by a caller, so no sender can forget it.
//
// MINIAPP_BASE is deliberately NOT SITE_URL: SITE_URL is the bare domain (a 307 hop to www) and cron-engagement
// falls back to '' when it is missing — a web_app url must be an absolute https origin.
import {
  encodeStartParam,
  type MiniAppSrc,
  type StartTarget,
  withTrack,
  type WatchTrack,
} from "./miniapp-links.ts";
import { logHealthOnce } from "./edge.ts";
import { isButtonRejection } from "./telegram-classify.ts";

export const DEFAULT_MINIAPP_BASE = "https://www.aicreator.academy";
export const DEFAULT_MINIAPP_DIRECT = "https://t.me/aicreatorsdarsliklari_bot/app";

const BASE_RE = /^https:\/\/[a-z0-9.-]+$/;
const DIRECT_RE = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,64}\/[A-Za-z0-9_]{3,64}$/;

function envOr(name: string, fallback: string): string {
  try {
    return Deno.env.get(name) || fallback;
  } catch {
    return fallback; // no env permission (tests) → the default
  }
}

/** A web_app origin, or null when it is not an absolute https origin with no path ('' and 'http://…' are null). */
export function normMiniAppBase(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/\/$/, "");
  return BASE_RE.test(s) ? s : null;
}

// ─────────────────────────── whose button (the fault rows) ───────────────────────────
/**
 * Whose Mini App a button opens. watch_button_health() sums every 'miniapp_button_fallback' /
 * 'miniapp_button_rejected' row, for any fn, into the STUDENT watch-button alarm (whose advice is the student
 * kill-switch) — a teacher-button fault must not raise it, and must not share its once-a-day dedupe key either
 * (a teacher rejection in telegram-bot-webhook would otherwise silence a student one for the rest of the day).
 */
export type ButtonAudience = "student" | "teacher";
export const BUTTON_FAULT_ACTIONS: Readonly<Record<ButtonAudience, { fallback: string; rejected: string }>> = {
  student: { fallback: "miniapp_button_fallback", rejected: "miniapp_button_rejected" },
  teacher: { fallback: "teacher_miniapp_button_fallback", rejected: "teacher_miniapp_button_rejected" },
};

/** The teacher Mini App's root (/tg/teacher, TeacherLayout). */
export const TEACHER_APP_ROOT = "/tg/teacher";

/** "/tg/teacher", "/tg/teacher/…" and "/tg/teacher?…" are the teacher Mini App; "/tg/teachers", "/dashboard" are not. */
export function isTeacherAppPath(path: string | null | undefined): boolean {
  const p = path ?? "";
  return p === TEACHER_APP_ROOT || p.startsWith(`${TEACHER_APP_ROOT}/`) || p.startsWith(`${TEACHER_APP_ROOT}?`);
}

/**
 * The audience of a message's web_app buttons: 'teacher' only when EVERY web_app button opens the teacher Mini
 * App. Anything else — a student button, a mixed keyboard, an unparseable url — is 'student', so a doubtful fault
 * still raises the student alarm rather than hiding from it.
 */
export function webAppAudience(replyMarkup: unknown): ButtonAudience {
  const rows = (replyMarkup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return "student";
  let teacher = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const b of row) {
      if (!b || typeof b !== "object" || !("web_app" in b)) continue;
      let pathname = "";
      try {
        pathname = new URL(String((b as { web_app?: { url?: unknown } }).web_app?.url ?? "")).pathname;
      } catch {
        return "student";
      }
      if (!isTeacherAppPath(pathname)) return "student";
      teacher++;
    }
  }
  return teacher > 0 ? "teacher" : "student";
}

/** A named-Mini-App direct link (https://t.me/<bot>/<app>), or null. */
export function normMiniAppDirect(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/\/$/, "");
  return DIRECT_RE.test(s) ? s : null;
}

export const MINIAPP_BASE = envOr("MINIAPP_BASE", DEFAULT_MINIAPP_BASE);
export const MINIAPP_DIRECT = envOr("MINIAPP_DIRECT_LINK", DEFAULT_MINIAPP_DIRECT);

// ─────────────────────────── the kill-switch ───────────────────────────
export type WatchFlag = { on: boolean; watch: boolean };
export const FLAG_OFF: WatchFlag = { on: false, watch: false };

/** platform_settings.student_miniapp.value → the flag. Only a literal `enabled: true` turns it on. */
export function parseStudentMiniAppFlag(value: unknown): WatchFlag {
  const v = (value && typeof value === "object") ? value as Record<string, unknown> : null;
  const on = v?.enabled === true;
  return { on, watch: on && v?.watch_buttons !== false };
}

let flagCache: { v: WatchFlag; at: number } | null = null;
const FLAG_TTL_MS = 60_000;

/** Test hook: forget the cached flag. */
export function _resetStudentMiniAppFlagCache() {
  flagCache = null;
}

/**
 * The student Mini App flag, cached 60 s per isolate. FAIL-CLOSED: an absent row, a malformed value
 * ({enabled:"true"}) or a read error gives {on:false, watch:false} — today's magic links. A read error is not
 * cached, so the next call retries.
 */
export async function loadStudentMiniAppFlag(admin: any, now: number = Date.now()): Promise<WatchFlag> {
  if (flagCache && now - flagCache.at < FLAG_TTL_MS) return flagCache.v;
  try {
    const { data, error } = await admin.from("platform_settings").select("value").eq("key", "student_miniapp").maybeSingle();
    if (error) {
      console.error("student-miniapp flag read failed (fail-closed)", error.message ?? String(error));
      return FLAG_OFF;
    }
    const v = parseStudentMiniAppFlag(data?.value);
    flagCache = { v, at: now };
    return v;
  } catch (e) {
    console.error("student-miniapp flag read threw (fail-closed)", String(e));
    return FLAG_OFF;
  }
}

// ─────────────────────────── the button ───────────────────────────
export type WebAppButton = { text: string; web_app: { url: string } };
export type UrlButton = { text: string; url: string };
export type InlineButton = WebAppButton | UrlButton;

export type WatchMode = "web_app" | "startapp" | "magic_link" | "none";
export type WatchReason = "ok" | "flag_off" | "watch_off" | "bad_base" | "group_flag_off" | "no_fallback";

/** What a sender's magic-link fallback returns: the url (and the token, for senders that store it). */
export type MagicLinkResult = string | { url: string; token?: string | null } | null;

type WatchCommon = {
  text: string;
  flag: WatchFlag;
  /** The sending function, for the health signals ("cron-engagement", "detect-and-nudge", …). */
  fn: string;
  /** Service-role client for the health signals. Optional: without it a bad base is only logged to the console. */
  admin?: unknown;
};

export type PrivateWatchOpts = WatchCommon & {
  chat: "private";
  /** Where the Mini App opens: continuePath(c) / lessonPath(c,l) / coursePath(c) / "/dashboard". */
  miniPath: string;
  /** Today's magic-link target, used only by the fallback. */
  legacyPath: string;
  track: WatchTrack;
  /** Today's link, byte-identical (each sender keeps its own purpose + expiry). Omit → no button when off. */
  magicLink?: (legacyPath: string) => Promise<MagicLinkResult>;
  /** Override MINIAPP_BASE (tests). */
  base?: string;
};

export type GroupWatchOpts = WatchCommon & {
  chat: "group";
  start: StartTarget;
  track: { src: MiniAppSrc };
  /** A magic link in a group logs whoever taps it into ONE student's account: not accepted, by type. */
  magicLink?: never;
  legacyPath?: never;
  /** Override MINIAPP_DIRECT (tests). */
  direct?: string;
};

export type WatchButtonOpts = PrivateWatchOpts | GroupWatchOpts;

export type WatchButtonResult = {
  button: InlineButton | null;
  mode: WatchMode;
  reason: WatchReason;
  /** The magic-link token, when the fallback returned one (nudge_log / re_engagement_deliveries store it). */
  token?: string | null;
};

async function badBase(opts: WatchCommon, what: string, audience: ButtonAudience) {
  const key = `bad_base:${opts.fn}`;
  const action = BUTTON_FAULT_ACTIONS[audience].fallback;
  if (opts.admin) {
    await logHealthOnce(opts.admin, action, key, { fn: opts.fn, reason: "bad_base", what });
  } else {
    console.error(`${action} ${key} (${what}) — no admin client, not recorded`);
  }
}

/** Run the sender's magic-link fallback; a throw or an empty result is 'no_fallback' (no button). */
export async function legacyWatchButton(
  opts: PrivateWatchOpts,
  reason: WatchReason,
): Promise<WatchButtonResult> {
  if (!opts.magicLink) return { button: null, mode: "none", reason };
  let r: MagicLinkResult = null;
  try {
    r = await opts.magicLink(opts.legacyPath);
  } catch (e) {
    console.error(`[${opts.fn}] magic-link fallback failed`, String((e as Error)?.message ?? e));
    return { button: null, mode: "none", reason: "no_fallback" };
  }
  const url = typeof r === "string" ? r : r?.url;
  if (!url) return { button: null, mode: "none", reason: "no_fallback" };
  const token = typeof r === "string" ? null : (r?.token ?? null);
  return { button: { text: opts.text, url }, mode: "magic_link", reason, token };
}

/** Build the watch button. Never throws. See the header for the decision table. */
export async function watchButton(opts: WatchButtonOpts): Promise<WatchButtonResult> {
  if (opts.chat === "group") {
    if (!opts.flag.on) return { button: null, mode: "none", reason: "group_flag_off" };
    const direct = normMiniAppDirect(opts.direct ?? MINIAPP_DIRECT);
    if (!direct) {
      await badBase(opts, "MINIAPP_DIRECT_LINK", "student"); // group start targets are student screens only
      return { button: null, mode: "none", reason: "bad_base" };
    }
    const url = `${direct}?startapp=${encodeStartParam(opts.start, opts.track.src)}`;
    return { button: { text: opts.text, url }, mode: "startapp", reason: "ok" };
  }

  if (opts.chat !== "private") {
    // Unreachable through the types; a JS caller that passes anything else gets no button, never a magic link.
    return { button: null, mode: "none", reason: "no_fallback" };
  }
  if (!opts.flag.on) return legacyWatchButton(opts, "flag_off");
  if (!opts.flag.watch) return legacyWatchButton(opts, "watch_off");
  const base = normMiniAppBase(opts.base ?? MINIAPP_BASE);
  if (!base) {
    await badBase(opts, "MINIAPP_BASE", isTeacherAppPath(opts.miniPath) ? "teacher" : "student");
    return legacyWatchButton(opts, "bad_base");
  }
  const path = opts.miniPath.startsWith("/") ? opts.miniPath : `/${opts.miniPath}`;
  return { button: { text: opts.text, web_app: { url: base + withTrack(path, opts.track) } }, mode: "web_app", reason: "ok" };
}

// ─────────────────────────── counting ───────────────────────────
export type ButtonTally = {
  web_app: number;
  startapp: number;
  magic_link: number;
  none: number;
  rejected: number;
  reasons: Record<string, number>;
};

export function newButtonTally(): ButtonTally {
  return { web_app: 0, startapp: 0, magic_link: 0, none: 0, rejected: 0, reasons: {} };
}

/** Count one built button. Only non-'ok' reasons are listed (the watchdog alarms on unexpected ones). */
export function tallyButton(t: ButtonTally, r: Pick<WatchButtonResult, "mode" | "reason">) {
  t[r.mode]++;
  if (r.reason !== "ok") t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1;
}

// ─────────────────────────── the rejection fallback ───────────────────────────
/** True when a reply_markup carries at least one web_app button. */
export function hasWebAppButton(replyMarkup: unknown): boolean {
  const rows = (replyMarkup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => Array.isArray(row) && row.some((b) => !!(b && typeof b === "object" && "web_app" in b)));
}

export type SendLike = { ok: boolean; status: number; error: string | null };

/**
 * Telegram refused the BUTTON — a 400 that positively names a button or a web app (BUTTON_TYPE_INVALID,
 * BUTTON_URL_INVALID, "…Web App URL … is invalid"; telegram-classify.ts isButtonRejection). Nothing was delivered,
 * so a resend without the web_app button cannot duplicate a message.
 *
 * It used to be "any 400 that is not a recipient error", which read every unlisted per-user 400 ("user not found")
 * and every content 400 that has nothing to do with the button ("can't parse entities", "message is too long",
 * "text must be encoded in UTF-8") as a Mini App button refusal: a student 'miniapp_button_rejected' alarm with
 * student kill-switch advice, plus a resend that fails the same way (incident 2026-10-01). Recipient errors and
 * transient ones (429 / 5xx / transport) are never retried here.
 */
export function isWatchContentRejection(r: SendLike): boolean {
  return isButtonRejection(r);
}

/**
 * Send; if Telegram rejects a message that carries a web_app button with a terminal CONTENT error, rebuild it
 * (the sender swaps in today's magic link, or drops the button) and resend ONCE, and alarm
 * ('miniapp_button_rejected', once per fn per day — 'teacher_miniapp_button_rejected' when every web_app button
 * opens the teacher Mini App, see webAppAudience). `rebuild` returning null means "no fallback payload".
 */
export async function sendWithWatchFallback<R extends SendLike>(
  send: (payload: Record<string, unknown>) => Promise<R>,
  payload: Record<string, unknown>,
  rebuild: () => Promise<Record<string, unknown> | null>,
  opts: { fn: string; admin?: unknown },
): Promise<{ result: R; retried: boolean }> {
  const first = await send(payload);
  if (first.ok || !hasWebAppButton(payload.reply_markup) || !isWatchContentRejection(first)) {
    return { result: first, retried: false };
  }
  const action = BUTTON_FAULT_ACTIONS[webAppAudience(payload.reply_markup)].rejected;
  if (opts.admin) {
    await logHealthOnce(opts.admin, action, `rejected:${opts.fn}`, {
      fn: opts.fn, status: first.status, error: first.error,
    });
  } else {
    console.error(`${action} ${opts.fn}: ${first.error}`);
  }
  let next: Record<string, unknown> | null = null;
  try {
    next = await rebuild();
  } catch (e) {
    console.error(`[${opts.fn}] watch-button rebuild failed`, String((e as Error)?.message ?? e));
  }
  if (!next) return { result: first, retried: false };
  return { result: await send(next), retried: true };
}
