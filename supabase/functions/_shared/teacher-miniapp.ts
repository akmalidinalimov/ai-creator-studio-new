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
// resent ONCE with today's button by the sender, through sendWithWatchFallback (alarmed as
// miniapp_button_rejected). The tap is reported by the Mini App as admin_actions 'miniapp_open' {src, ref}.
//
// KILL-SWITCH: platform_settings.teacher_miniapp = {"enabled": bool} — the SAME row the bot's 📝 Baholash
// keyboard button and the ☰ "📝 Ustoz" menu button follow. Absent row → ON (the seed is {"enabled": true} and
// the webhook reads an absent row the same way); present row → only a literal true. UNLIKE the webhook's
// keyboard reader, a READ ERROR here is OFF (today's buttons always work) and DB-visible
// ('teacher_miniapp_flag_read_failed', once a day per sending function).
import { type InlineButton, watchButton, type WatchFlag, FLAG_OFF } from "./miniapp-button.ts";
import { isUuid, type MiniAppSrc } from "./miniapp-links.ts";
import { logHealthOnce } from "./edge.ts";

export const TEACHER_HOME_PATH = "/tg/teacher";
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
  src: MiniAppSrc;
  /** Rides in the open signal (e.g. the submission id). Dropped when not a UUID. */
  ref?: string | null;
  fn: string;
  admin?: unknown;
  /** Override MINIAPP_BASE (tests). */
  base?: string;
};

/**
 * The web_app button into the teacher Mini App, or null when the sender must keep today's button: flag off,
 * a malformed MINIAPP_BASE (alarmed once a day as miniapp_button_fallback), a path outside /tg/teacher, or a
 * chat that is not private. Never throws.
 */
export async function teacherAppButton(o: TeacherAppButtonOpts): Promise<InlineButton | null> {
  if (!(Number(o.chatId) > 0)) return null;
  if (!o.path.startsWith(TEACHER_HOME_PATH)) return null;
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
