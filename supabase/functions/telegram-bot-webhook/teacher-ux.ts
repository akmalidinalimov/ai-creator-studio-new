// Teacher-facing bot surfaces (UX review 2026-09-30, quick wins #6 and the non-keyboard parts of #11), kept OUT
// of index.ts so that file only changes at its call sites. Every Mini App button here is built by
// _shared/teacher-miniapp.ts (on _shared/miniapp-button.ts) and follows platform_settings.teacher_miniapp.
//
//   hwTeacherDmKeyboard / sendHwTeacherDm — the immediate new-homework DM (notifyTeachersOfSubmission).
//       🎯 Baholash opens THIS submission in the teacher Mini App (/tg/teacher/grade?sub=<id>); the in-chat flow
//       (grade:open) stays as the second button — it is where Telegram's voice recorder works. Flag off → today's
//       keyboard, byte-identical. A web_app button Telegram rejects is resent ONCE with today's keyboard
//       (recorded as 'teacher_miniapp_button_rejected' — never the student watch-button alarm's row).
//   teacherCardRows / teacherCardKeyboard — the 👤 Profil card's buttons. /start has always said "TOP, faolsizlar,
//       guruh almashtirish va sozlamalar — 👤 Profil ichida", but the card only had group switchers, so
//       /ttop, /tinactive and /sozlamalar could only be typed. Now: [🏆 TOP] [😴 Faolsizlar] [⚙️ Sozlamalar]
//       (reusing the existing tg:pick:<cmd>:<group> and prof:settings callbacks — no new handler), and
//       [📊 Statistika ↗] [📣 Guruhga xabar ↗] into the teacher Mini App.
//   sendTeacherCard / editTeacherCard — send / edit the card with the same one-shot web_app rejection fallback.
//   teacherStartGreeting — the teacher /start text; the reply keyboard it rides on is UNCHANGED (getTeacherKeyboard).
//
// PRIVATE CHATS ONLY: web_app buttons work only there. Every caller is a private-chat handler (group updates return
// early in index.ts), and teacherAppButton also refuses a non-positive chat id.
import { BUTTON_FAULT_ACTIONS, hasWebAppButton, sendWithWatchFallback } from "../_shared/miniapp-button.ts";
import { isUuid } from "../_shared/miniapp-links.ts";
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";
import { logHealthOnce } from "../_shared/edge.ts";
import {
  GRADE_APP_LABEL,
  GRADE_CHAT_LABEL,
  loadTeacherMiniAppFlag,
  teacherAppButton,
  TEACHER_BROADCAST_PATH,
  teacherGradePath,
  TEACHER_STATS_PATH,
} from "../_shared/teacher-miniapp.ts";

// deno-lint-ignore no-explicit-any
export type Btn = Record<string, any>;
export type Kb = { inline_keyboard: Btn[][] };
export type UxLocale = "uz" | "ru" | "en";

const FN = "telegram-bot-webhook";

const BOT_TOKEN = (() => {
  try {
    return Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  } catch {
    return "";
  }
})();

// ─────────────────────────── the new-homework DM ───────────────────────────
/**
 * The immediate DM's keyboard (uz, like the DM body). grade:open:<uuid> = 47 bytes, hwmv:<uuid> = 41 — under
 * Telegram's 64-byte callback_data cap (the old grade_task:<assignment>:<student> was 84 → BUTTON_DATA_INVALID).
 *   gradeApp null → today's: [🎯 Baholash (grade:open)] · [✏️ retag]? · [📌 Topikga o'tish]
 *   gradeApp      → [🎯 Baholash ↗] · [🎤 Chatda (ovoz bilan) (grade:open)] · [✏️ retag]? · [📌 Topikga o'tish]
 */
export function hwTeacherDmKeyboard(a: {
  submissionId: string;
  messageUrl: string | null | undefined;
  guessed: boolean;
  gradeApp: Btn | null;
}): Kb {
  const retag = a.guessed ? [[{ text: "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${a.submissionId}` }]] : [];
  const topic = [[{ text: "📌 Topikga o'tish", url: a.messageUrl }]];
  if (!a.gradeApp) {
    return { inline_keyboard: [[{ text: "🎯 Baholash", callback_data: `grade:open:${a.submissionId}` }], ...retag, ...topic] };
  }
  return {
    inline_keyboard: [
      [a.gradeApp],
      [{ text: GRADE_CHAT_LABEL.uz, callback_data: `grade:open:${a.submissionId}` }],
      ...retag,
      ...topic,
    ],
  };
}

export type HwDmOutcome = { ok: boolean; status: number; error: string | null; button: "web_app" | "callback" };

/**
 * Send the new-homework DM to one teacher, exactly as index.ts's sendMessage did (HTML, no preview), through
 * sendTelegram (record:false — the homework_teacher_dm_queue row IS this send's ledger: an unsent row is retried
 * by notify-homework-submission, which records its own outcome). Never throws.
 */
// deno-lint-ignore no-explicit-any
export async function sendHwTeacherDm(admin: any, a: {
  chatId: number;
  body: string;
  submissionId: string;
  messageUrl: string | null | undefined;
  guessed: boolean;
}, deps: { send?: (p: Record<string, unknown>) => Promise<SendOutcome> } = {}): Promise<HwDmOutcome> {
  const send = deps.send ?? ((p) => sendTelegram(BOT_TOKEN, "sendMessage", p, { record: false }));
  try {
    const flag = await loadTeacherMiniAppFlag(admin, FN);
    const gradeApp = await teacherAppButton({
      text: GRADE_APP_LABEL.uz, flag, chatId: a.chatId, path: teacherGradePath(a.submissionId),
      src: "teacher_hw_dm", ref: a.submissionId, fn: FN, admin,
    });
    const payload = (app: Btn | null) => ({
      chat_id: a.chatId,
      text: a.body,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: hwTeacherDmKeyboard({ submissionId: a.submissionId, messageUrl: a.messageUrl, guessed: a.guessed, gradeApp: app }),
    });
    const { result, retried } = await sendWithWatchFallback(
      send, payload(gradeApp), async () => (gradeApp ? payload(null) : null), { fn: FN, admin },
    );
    return { ok: result.ok, status: result.status, error: result.error, button: gradeApp && !retried ? "web_app" : "callback" };
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error)?.message ?? e).slice(0, 200), button: "callback" };
  }
}

// ─────────────────────────── the 👤 Profil card ───────────────────────────
const CARD_T: Record<UxLocale, { top: string; inactive: string; settings: string; stats: string; broadcast: string }> = {
  uz: { top: "🏆 TOP", inactive: "😴 Faolsizlar", settings: "⚙️ Sozlamalar", stats: "📊 Statistika", broadcast: "📣 Guruhga xabar" },
  ru: { top: "🏆 ТОП", inactive: "😴 Неактивные", settings: "⚙️ Настройки", stats: "📊 Статистика", broadcast: "📣 Сообщение группе" },
  en: { top: "🏆 Top", inactive: "😴 Inactive", settings: "⚙️ Settings", stats: "📊 Stats", broadcast: "📣 Message group" },
};

/**
 * The card's rows. Pure.
 *   canPick (the viewer acts as a TEACHER — tg:pick answers teachers only) + a UUID group:
 *     [🏆 TOP (tg:pick:ttop:<g>)] [😴 Faolsizlar (tg:pick:tinactive:<g>)] [⚙️ Sozlamalar (prof:settings)]
 *   otherwise: [⚙️ Sozlamalar]
 *   app buttons, when built: [📊 Statistika ↗] [📣 Guruhga xabar ↗]
 *   then the existing group switchers.
 * tg:pick:tinactive:<uuid> = 54 bytes, tg:pick:ttop:<uuid> = 49 — under the 64-byte cap. Both callbacks already
 * exist (the /tstats and group-picker buttons use them): they set the active group and run the same command the
 * teacher could type, scoped to the group on this card.
 */
export function teacherCardRows(a: {
  locale: UxLocale;
  groupId: string | null | undefined;
  canPick: boolean;
  stats: Btn | null;
  broadcast: Btn | null;
  switchRows: Btn[][];
}): Btn[][] {
  const t = CARD_T[a.locale] ?? CARD_T.uz;
  const settings = { text: t.settings, callback_data: "prof:settings" };
  const rows: Btn[][] = [];
  if (a.canPick && isUuid(a.groupId)) {
    rows.push([
      { text: t.top, callback_data: `tg:pick:ttop:${a.groupId}` },
      { text: t.inactive, callback_data: `tg:pick:tinactive:${a.groupId}` },
      settings,
    ]);
  } else {
    rows.push([settings]);
  }
  const app = [a.stats, a.broadcast].filter((b): b is Btn => !!b);
  if (app.length) rows.push(app);
  return [...rows, ...a.switchRows];
}

/** The card's keyboard, with the Mini App buttons built for this chat (null chat → no app buttons). */
// deno-lint-ignore no-explicit-any
export async function teacherCardKeyboard(admin: any, a: {
  chatId: number | null | undefined;
  locale: UxLocale;
  groupId: string | null | undefined;
  canPick: boolean;
  switchRows: Btn[][];
}): Promise<Kb> {
  const t = CARD_T[a.locale] ?? CARD_T.uz;
  let stats: Btn | null = null, broadcast: Btn | null = null;
  if (Number(a.chatId) > 0) {
    const flag = await loadTeacherMiniAppFlag(admin, FN);
    const mk = (text: string, path: string) =>
      teacherAppButton({ text, flag, chatId: a.chatId, path, src: "teacher_card", fn: FN, admin });
    [stats, broadcast] = await Promise.all([mk(t.stats, TEACHER_STATS_PATH), mk(t.broadcast, TEACHER_BROADCAST_PATH)]);
  }
  return { inline_keyboard: teacherCardRows({ ...a, stats, broadcast }) };
}

/** The keyboard without its web_app buttons (empty rows dropped; undefined when nothing is left). Pure. */
export function withoutWebApp(kb: Kb | undefined | null): Kb | undefined {
  if (!kb?.inline_keyboard) return undefined;
  const rows = kb.inline_keyboard
    .map((row) => row.filter((b) => !(b && typeof b === "object" && "web_app" in b)))
    .filter((row) => row.length > 0);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** "Bad Request: message is not modified" — an edit that changed nothing. A no-op success, not a failure. */
export function isNotModified(error: string | null | undefined): boolean {
  return /message is not modified/i.test(error || "");
}

/**
 * Telegram refused a BUTTON (BUTTON_TYPE_INVALID, BUTTON_URL_INVALID, "…Web App URL … is invalid") — the only
 * 400 a resend without the web_app buttons can fix. Narrower than the shared isWatchContentRejection on purpose:
 * an edit also fails with "message to edit not found" / "message can't be edited", which must neither be retried
 * nor raise the teacher_miniapp_button_rejected signal.
 */
export function isButtonRejection(r: { ok: boolean; status: number; error: string | null }): boolean {
  return !r.ok && r.status === 400 && /button|web ?app/i.test(r.error || "");
}

type CardDeps = { send?: (method: string, p: Record<string, unknown>, record: boolean) => Promise<SendOutcome> };

async function cardSend(
  // deno-lint-ignore no-explicit-any
  admin: any, method: "sendMessage" | "editMessageText", base: Record<string, unknown>, keyboard: Kb | undefined,
  deps: CardDeps,
): Promise<SendOutcome> {
  // A card SENT in reply to 👤 Profil is recorded when it fails (the teacher just wrote to us, so a miss is not
  // expected); an EDIT is not (an old card can legitimately be uneditable).
  const record = method === "sendMessage";
  const raw = deps.send ?? ((m, p, r) => sendTelegram(BOT_TOKEN, m, p, { admin, purpose: "teacher_card", recipientId: base.chat_id as number, record: r }));
  const send = async (p: Record<string, unknown>) => {
    const r = await raw(method, p, record);
    return isNotModified(r.error) ? { ...r, ok: true } : r;
  };
  const payload = (kb: Kb | undefined) => ({ ...base, parse_mode: "HTML", disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) });
  try {
    const first = await send(payload(keyboard));
    if (first.ok || !hasWebAppButton(keyboard) || !isButtonRejection(first)) return first;
    // The TEACHER fault row (BUTTON_FAULT_ACTIONS.teacher), once per day for the card: the card's web_app buttons
    // open /tg/teacher, and 'miniapp_button_rejected' would raise the STUDENT watch-button alarm.
    await logHealthOnce(admin, BUTTON_FAULT_ACTIONS.teacher.rejected, `rejected:${FN}:teacher_card`, {
      fn: FN, what: "teacher_card", method, status: first.status, error: first.error,
    });
    return await send(payload(withoutWebApp(keyboard)));
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error)?.message ?? e).slice(0, 200), terminal: false, recipient: false, content: false };
  }
}

/** Send the 👤 Profil card (index.ts used sendMessage: HTML, no preview). Never throws. */
// deno-lint-ignore no-explicit-any
export function sendTeacherCard(admin: any, chatId: number, text: string, keyboard?: Kb, deps: CardDeps = {}) {
  return cardSend(admin, "sendMessage", { chat_id: chatId, text }, keyboard, deps);
}

/** Re-render the card in place (the tprof:g group switch). Never throws. */
// deno-lint-ignore no-explicit-any
export function editTeacherCard(admin: any, chatId: number, messageId: number | undefined, text: string, keyboard?: Kb, deps: CardDeps = {}) {
  return cardSend(admin, "editMessageText", { chat_id: chatId, message_id: messageId, text }, keyboard, deps);
}

// ─────────────────────────── /start ───────────────────────────
/**
 * The teacher /start greeting. `name` is already HTML-escaped. The ☰ line appears only when the teacher Mini App
 * (the webhook's own flag, which also sets that ☰ button) is on. The Profil line is now true: the card carries
 * TOP / Faolsizlar / Sozlamalar and the group switchers.
 */
export function teacherStartGreeting(locale: UxLocale, name: string, pending: number, appOn: boolean): string {
  const pend = Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0;
  if (locale === "ru") {
    return `Салом, ${name}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} заданий</b> ждут проверки.` : "✅ Непроверенных заданий нет."}\n\n` +
      "👤 В Профиле: 🏆 ТОП, 😴 неактивные, ⚙️ настройки и смена группы." +
      (appOn ? "\n📱 Проверка, статистика и сообщение группе — в приложении ☰ «📝 Устоз» внизу слева." : "");
  }
  if (locale === "en") {
    return `Hi ${name}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} submissions</b> are waiting.` : "✅ Nothing waiting to grade."}\n\n` +
      "👤 In Profile: 🏆 top students, 😴 inactive, ⚙️ settings and group switching." +
      (appOn ? "\n📱 Grading, stats and group messages — in the ☰ «📝 Teacher» app, bottom left." : "");
  }
  return `Salom, ${name}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} ta vazifa</b> baholashni kutmoqda.` : "✅ Baholanmagan vazifalar yo'q."}\n\n` +
    "👤 Profil ichida: 🏆 TOP talabalar, 😴 faolsizlar, ⚙️ sozlamalar va guruh almashtirish." +
    (appOn ? "\n📱 Baholash, statistika va guruhga xabar — pastda chapdagi ☰ «📝 Ustoz» ilovasida." : "");
}
