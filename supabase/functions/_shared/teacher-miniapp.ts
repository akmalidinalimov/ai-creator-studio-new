// teacher-miniapp — the ONE helper for buttons that open the TEACHER Mini App (/tg/teacher/*) from a DM.
//
// WHY (UX review 2026-09-30, quick wins #6, #10, #11): teachers grade in the app — at least 100 of 116 grades in
// 30 days went through the app path — yet every bot message they get pointed somewhere else:
//   * the new-homework DM (184 in 30 days, the message teachers get most) and the 24 h ungraded reminder carried
//     🎯 Baholash as a callback into the slow in-chat flow (4 taps from 2 teachers in 30 days);
//   * the daily report (136 in 30 days) said how much was waiting but its only button was a one-time Profil
//     magic link opened in Telegram's browser;
//   * the 👤 Profil card had no way into the app at all.
// Now each of them carries an inline web_app button into the exact screen: /tg/teacher/grade?sub=<id> opens THAT
// submission first (TeacherGrade), /tg/teacher/grade the queue, /tg/teacher the home, /tg/teacher/stats and
// /tg/teacher/broadcast from the card. The in-chat flow stays as a secondary button (it is where Telegram's
// voice recorder works).
//
//   private chat + flag on   → {text, web_app:{url: MINIAPP_BASE + path + ?src=<src>[&ref=<id>]}}
//   flag off / bad base / not a private chat → null — the sender keeps TODAY's button, byte-identical
//
// Built on _shared/miniapp-button.ts (watchButton: MINIAPP_BASE validation + its bad_base alarm, the open-signal
// tracking params). It never builds a magic link (each sender's today-button IS its fallback) and never a group
// link: web_app buttons work only in private chats (a positive chat id). A web_app button Telegram rejects is
// resent ONCE with today's button by the sender, through sendWithWatchFallback.
//
// TEACHER SIGNALS STAY OUT OF THE STUDENT DETECTOR. watch_button_health() / watch_button_watchdog count every
// 'miniapp_open' and every 'miniapp_button_fallback' / 'miniapp_button_rejected' row as STUDENT watch-button
// evidence (opens_missing, fallback_fault — with the student kill-switch as the advice). So, by construction:
//   the tap        → 'teacher_miniapp_open' {src, ref}  (tg-miniapp-auth/open.ts, TEACHER_MINIAPP_SRCS)
//   a bad base     → 'teacher_miniapp_button_fallback'   (miniapp-button.ts: the path is under /tg/teacher)
//   a rejection    → 'teacher_miniapp_button_rejected'   (miniapp-button.ts: every web_app button is /tg/teacher)
// All three stay DB-visible in admin_actions; no watchdog reads them yet (a teacher-button detector needs a
// migration of its own).
//
// KILL-SWITCH: platform_settings.teacher_miniapp = {"enabled": bool} — the SAME row the bot's 📝 Baholash
// keyboard button and the ☰ "📝 Ustoz" menu button follow. Absent row → ON (the seed is {"enabled": true} and
// the webhook reads an absent row the same way); present row → only a literal true. UNLIKE the webhook's
// keyboard reader, a READ ERROR here is OFF (today's buttons always work) and DB-visible
// ('teacher_miniapp_flag_read_failed', once a day per sending function).
import { type InlineButton, isTeacherAppPath, TEACHER_APP_ROOT, watchButton, type WatchFlag, FLAG_OFF } from "./miniapp-button.ts";
import { isTeacherMiniAppSrc, isUuid, type TeacherMiniAppSrc } from "./miniapp-links.ts";
import { logHealthOnce } from "./edge.ts";

export const TEACHER_HOME_PATH = TEACHER_APP_ROOT;
export const TEACHER_GRADE_PATH = "/tg/teacher/grade";
export const TEACHER_STATS_PATH = "/tg/teacher/stats";
export const TEACHER_BROADCAST_PATH = "/tg/teacher/broadcast";

/** "/tg/teacher/grade?sub=<uuid>" — THAT submission first; a missing or non-UUID id gives the plain queue. */
export function teacherGradePath(submissionId?: string | null): string {
  return isUuid(submissionId) ? `${TEACHER_GRADE_PATH}?sub=${submissionId.toLowerCase()}` : TEACHER_GRADE_PATH;
}

// ─────────────────────────── labels (uz / ru / en) ───────────────────────────
export type TeacherLocale = "uz" | "ru" | "en";
export const normTeacherLocale = (c?: string | null): TeacherLocale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  return l === "ru" ? "ru" : l === "en" ? "en" : "uz";
};

/** The primary button: the same words as today's 🎯 button, now opening the app. */
export const GRADE_APP_LABEL: Record<TeacherLocale, string> = { uz: "🎯 Baholash", ru: "🎯 Оценить", en: "🎯 Grade" };
/** The in-chat grading flow, kept as the secondary button: score, then a comment or a 🎤 voice note. */
export const GRADE_CHAT_LABEL: Record<TeacherLocale, string> = {
  uz: "🎤 Chatda (ovoz bilan)",
  ru: "🎤 В чате (голосом)",
  en: "🎤 In chat (voice)",
};

// ─────────────────────────── the kill-switch ───────────────────────────
/** A platform_settings row (or its absence) → the flag. Absent → on; present → only `enabled: true`. */
export function parseTeacherMiniAppFlag(row: { value?: unknown } | null | undefined): WatchFlag {
  if (!row) return { on: true, watch: true };
  const v = (row.value && typeof row.value === "object") ? row.value as Record<string, unknown> : null;
  const on = v?.enabled === true;
  return { on, watch: on };
}

let flagCache: { v: WatchFlag; at: number } | null = null;
const FLAG_TTL_MS = 60_000;

/** Test hook: forget the cached flag. */
export function _resetTeacherMiniAppFlagCache() {
  flagCache = null;
}

/** platform_settings.teacher_miniapp, cached 60 s per isolate. A read error is OFF, not cached, and recorded. */
// deno-lint-ignore no-explicit-any
export async function loadTeacherMiniAppFlag(admin: any, fn: string, now: number = Date.now()): Promise<WatchFlag> {
  if (flagCache && now - flagCache.at < FLAG_TTL_MS) return flagCache.v;
  let error: string | null = null;
  try {
    const { data, error: e } = await admin.from("platform_settings").select("value").eq("key", "teacher_miniapp").maybeSingle();
    if (!e) {
      const v = parseTeacherMiniAppFlag(data);
      flagCache = { v, at: now };
      return v;
    }
    error = String(e.message ?? e);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  console.error(`[${fn}] teacher_miniapp flag read failed — today's buttons this time`, error);
  await logHealthOnce(admin, "teacher_miniapp_flag_read_failed", fn, { fn, error: (error || "").slice(0, 300) }, { source: fn });
  return FLAG_OFF;
}

// ─────────────────────────── the button ───────────────────────────
export type TeacherAppButtonOpts = {
  text: string;
  flag: WatchFlag;
  /** The recipient chat. Only a private chat (a positive id) gets a web_app button. */
  chatId: number | string | null | undefined;
  /** An in-app path under /tg/teacher (TEACHER_*_PATH or teacherGradePath(id)). */
  path: string;
  /** A TEACHER source only (by type): its tap is recorded as 'teacher_miniapp_open', never as a student open. */
  src: TeacherMiniAppSrc;
  /** Rides in the open signal (e.g. the submission id). Dropped when not a UUID. */
  ref?: string | null;
  fn: string;
  admin?: unknown;
  /** Override MINIAPP_BASE (tests). */
  base?: string;
};

/**
 * The web_app button into the teacher Mini App, or null when the sender must keep today's button: flag off,
 * a malformed MINIAPP_BASE (recorded once a day as teacher_miniapp_button_fallback), a path outside /tg/teacher,
 * a source that is not a teacher source, or a chat that is not private. Never throws.
 */
export async function teacherAppButton(o: TeacherAppButtonOpts): Promise<InlineButton | null> {
  if (!(Number(o.chatId) > 0)) return null;
  // The same path test the fault rows use (isTeacherAppPath) — "/tg/teachers" must not pass here and then be
  // filed as a STUDENT fault; and a JS caller's student src would make the tap a student open.
  if (!isTeacherAppPath(o.path) || !isTeacherMiniAppSrc(o.src)) return null;
  try {
    const r = await watchButton({
      chat: "private", text: o.text, flag: o.flag, fn: o.fn, admin: o.admin,
      miniPath: o.path, legacyPath: o.path, track: { src: o.src, ref: o.ref ?? null }, base: o.base,
      // no magicLink: when the flag is off the sender keeps its own (callback / magic-link) button
    });
    return r.mode === "web_app" ? r.button : null;
  } catch (e) {
    console.error(`[${o.fn}] teacher app button failed — today's button`, String((e as Error)?.message ?? e));
    return null;
  }
}
