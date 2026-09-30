// The ☰ menu button (setChatMenuButton) — ONE builder and ONE applier, shared by the live sync (a member's
// private message OR inline-button tap, index.ts) and the sweep over every current member (menu-sweep.ts).
//
// WHY (UX review 2026-09-30, quick win #2): the ☰ button is the Mini App door that always carries signed
// initData — a reply-keyboard web_app button opens WITHOUT it, and the Mini App then falls back to the website
// login. The button was set only when a member TYPED a private message (never on a button tap, never in bulk),
// and a failure went to console.error only: 102 of 157 current students had it.
//
// SCOPE — per chat, members only, never the bot-wide default: a global default would give non-members an app
// door, and the membership gate promises them one plain sentence and no buttons. The kill-switches are the
// existing flags, read by the caller:
//   student → platform_settings.student_miniapp   on: 🚀 Ilovani ochish → <base>/dashboard   off: default menu
//   staff   → platform_settings.teacher_miniapp   on: 📝 Ustoz → <base>/tg/teacher          off: default menu
// (the same labels and URLs the bot has set since #149 / Teacher Mini App Phase 1 — nothing moves for the 102).
//
// OUTCOMES (classifyMenuOutcome) and what is recorded (recordMenuOutcome) — every non-ok one is DB-visible:
//   ok           accepted
//   unreachable  a recipient error (never pressed Start, blocked, deleted): the reach metric. Counted by the
//                sweep, never alarmed — expected and high-volume (member forgiveness).
//   rejected     a web_app menu button refused with a 400 that is not about the recipient: Telegram will not
//                take our Mini App URL or label → admin_actions 'miniapp_button_rejected' (once a day), the row
//                watch_button_watchdog already alarms on.
//   failed       anything else (429, 5xx, transport) → 'menu_button_sync_failed' (once a day per where/method/
//                status). Visible, not alarmed; the next interaction or the next sweep pass retries it.
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";
import { logHealthOnce } from "../_shared/edge.ts";
import { chatCommandCall, COMMANDS_VERSION, type CommandRole, type Locale, type TgCall } from "./bot-commands.ts";

export type { Locale, TgCall } from "./bot-commands.ts";

const BOT_TOKEN = (() => {
  try {
    return Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  } catch {
    return "";
  }
})();

/** The bot's Telegram call for menus/commands. record:false — the callers record their own outcome (above). */
export const botCall: TgCall = (method, payload) => sendTelegram(BOT_TOKEN, method, payload, { record: false });

export type MenuRole = CommandRole; // "student" | "teacher" | "admin"
export type MenuButton =
  | { type: "default" }
  | { type: "web_app"; text: string; web_app: { url: string } };

/** Same strings as index.ts MINIAPP_STUDENT_LABEL (the 🚀 keyboard row) and the teacher ☰ since Phase 1. */
export const STUDENT_MENU_LABEL: Record<Locale, string> = {
  uz: "🚀 Ilovani ochish",
  ru: "🚀 Открыть приложение",
  en: "🚀 Open the app",
};
export const STAFF_MENU_LABEL: Record<Locale, string> = {
  uz: "📝 Ustoz",
  ru: "📝 Устоз",
  en: "📝 Teacher",
};

export const isStaff = (role: MenuRole): boolean => role === "teacher" || role === "admin";

/** The menu button a member should have. `on` is the role's flag (student_miniapp / teacher_miniapp). */
export function menuButtonFor(role: MenuRole, on: boolean, locale: Locale, base: string): MenuButton {
  if (!on) return { type: "default" };
  const l: Locale = locale === "ru" || locale === "en" ? locale : "uz";
  return isStaff(role)
    ? { type: "web_app", text: STAFF_MENU_LABEL[l], web_app: { url: `${base}/tg/teacher` } }
    : { type: "web_app", text: STUDENT_MENU_LABEL[l], web_app: { url: `${base}/dashboard` } };
}

/** A stable identity for "this exact menu (and, for staff, this command list)". */
export function menuKey(mb: MenuButton, role: MenuRole, locale: Locale): string {
  const cmd = isStaff(role) ? `|cmd:${COMMANDS_VERSION}:${role}:${locale}` : "";
  return (mb.type === "default" ? "default" : `web_app|${mb.text}|${mb.web_app.url}`) + cmd;
}

export type MenuOutcome = "ok" | "unreachable" | "rejected" | "failed";

export function classifyMenuOutcome(o: SendOutcome, webApp: boolean): MenuOutcome {
  if (o.ok) return "ok";
  if (o.recipient) return "unreachable";
  if (webApp && o.status === 400) return "rejected";
  return "failed";
}

/** Record a non-ok outcome (see the header). ok / unreachable write nothing here. Never throws. */
export async function recordMenuOutcome(
  admin: unknown,
  outcome: MenuOutcome,
  o: SendOutcome,
  ctx: { where: "live" | "sweep"; method: string; role: MenuRole },
): Promise<void> {
  if (!admin || outcome === "ok" || outcome === "unreachable") return;
  const details = {
    fn: `menu_button_${ctx.where}`,
    method: ctx.method,
    role: ctx.role,
    status: o.status,
    error: o.error, // Telegram's description only — never the token
  };
  if (outcome === "rejected") {
    await logHealthOnce(admin, "miniapp_button_rejected", `rejected:menu_button:${ctx.method}`, details, {
      source: "telegram-bot-webhook",
    });
  } else {
    await logHealthOnce(admin, "menu_button_sync_failed", `${ctx.where}:${ctx.method}:${o.status}`, details, {
      source: "telegram-bot-webhook",
    });
  }
}

/** setChatMenuButton for one private chat; classified + recorded. */
export async function applyMenuButton(
  admin: unknown,
  call: TgCall,
  chatId: number,
  mb: MenuButton,
  ctx: { where: "live" | "sweep"; role: MenuRole },
): Promise<MenuOutcome> {
  const o = await call("setChatMenuButton", { chat_id: chatId, menu_button: mb });
  const outcome = classifyMenuOutcome(o, mb.type === "web_app");
  await recordMenuOutcome(admin, outcome, o, { ...ctx, method: "setChatMenuButton" });
  return outcome;
}

/** setMyCommands for a teacher's / admin's own chat (no-op "ok" for a student); classified + recorded. */
export async function applyChatCommands(
  admin: unknown,
  call: TgCall,
  chatId: number,
  role: MenuRole,
  locale: Locale,
  where: "live" | "sweep",
): Promise<MenuOutcome> {
  const p = chatCommandCall(chatId, role, locale);
  if (!p) return "ok";
  const o = await call("setMyCommands", p);
  const outcome = classifyMenuOutcome(o, false);
  await recordMenuOutcome(admin, outcome, o, { where, method: "setMyCommands", role });
  return outcome;
}

// ─────────────────────────── the live sync ───────────────────────────
// Per isolate: one entry per chat, re-applied at most once an hour for the same menu (and at once when it
// changes — a flag flip, a role change, a language change). A failure is not cached, so the member's next
// interaction retries it. `sig` is the flag snapshot the entry was made under: the tap path uses it to skip
// the persona lookup entirely when nothing can have changed.
const LIVE_TTL_MS = 3_600_000;
const LIVE_MAX = 5000;
const live = new Map<number, { key: string; sig: string; at: number }>();

/** Test hook. */
export function _resetLiveMenuSync() {
  live.clear();
}

/** The flag snapshot a live entry is valid under. */
export const flagSig = (studentOn: boolean, teacherOn: boolean, base: string): string =>
  `${studentOn ? 1 : 0}${teacherOn ? 1 : 0}|${base}`;

/** True when this chat was synced under the same flags within the hour (the tap path's cheap pre-check). */
export function liveFresh(chatId: number, sig: string, now: number = Date.now()): boolean {
  const e = live.get(chatId);
  return !!e && e.sig === sig && now - e.at < LIVE_TTL_MS;
}

export type LiveSyncOpts = {
  role: MenuRole;
  locale: Locale;
  on: boolean;
  base: string;
  sig: string;
  call?: TgCall;
  now?: number;
};

/**
 * Bring one member's ☰ (and, for staff, their "/" list) to the desired state. PRIVATE chats only (a positive
 * chat id). Returns "skipped" when this isolate already applied the same state within the hour. Never throws.
 */
export async function syncMenuLive(admin: unknown, chatId: number, opts: LiveSyncOpts): Promise<MenuOutcome | "skipped"> {
  if (!(Number(chatId) > 0)) return "skipped";
  const now = opts.now ?? Date.now();
  const mb = menuButtonFor(opts.role, opts.on, opts.locale, opts.base);
  const key = menuKey(mb, opts.role, opts.locale);
  const prev = live.get(chatId);
  if (prev && prev.key === key && now - prev.at < LIVE_TTL_MS) {
    if (prev.sig !== opts.sig) live.set(chatId, { ...prev, sig: opts.sig });
    return "skipped";
  }
  const call = opts.call ?? botCall;
  try {
    let outcome = await applyMenuButton(admin, call, chatId, mb, { where: "live", role: opts.role });
    if (outcome === "ok" && isStaff(opts.role)) {
      outcome = await applyChatCommands(admin, call, chatId, opts.role, opts.locale, "live");
    }
    if (outcome === "ok" || outcome === "unreachable") {
      if (live.size >= LIVE_MAX) live.clear();
      live.set(chatId, { key, sig: opts.sig, at: now });
    }
    return outcome;
  } catch (e) {
    console.error("menu-button: live sync threw", String((e as Error)?.message ?? e));
    return "failed";
  }
}
