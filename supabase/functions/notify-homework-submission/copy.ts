// The queued new-homework DM text (tested in copy.test.ts). Every row of homework_teacher_dm_queue is delivered
// with this text: quiet-hours submissions, Mini App / web submissions (submit-homework only queues) and the
// reconciler's re-queued rows. It used to carry only "Modul N · Vazifa N «title»", which reads the same for a
// 5.0 task and its Challenge 6.0 copy, and never said which group the student is in (audit BOT-3).
import { hwLabel, type HwLabelParts } from "../_shared/hw-label.ts";

export type Locale = "uz" | "ru" | "en";

export const escHtml = (s: string = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MSG: Record<Locale, (name: string, label: string) => string> = {
  uz: (name, label) => `📝 <b>Yangi topshiriq</b>\n\n<b>${name}</b> vazifa topshirdi:\n📌 <b>${label}</b>`,
  ru: (name, label) => `📝 <b>Новая работа</b>\n\n<b>${name}</b> отправил(а) работу:\n📌 <b>${label}</b>`,
  en: (name, label) => `📝 <b>New submission</b>\n\n<b>${name}</b> submitted:\n📌 <b>${label}</b>`,
};

/** The DM body. `parts` are raw (unescaped); the label is escaped here. */
export function submissionDmText(loc: Locale, studentName: string | null | undefined, parts: HwLabelParts): string {
  const label = hwLabel(parts) || "—";
  return MSG[loc](escHtml(studentName || "—"), escHtml(label));
}

// ─────────────────────────── the keyboard ───────────────────────────
// deno-lint-ignore no-explicit-any
type Btn = Record<string, any>;

const POST_LABEL: Record<Locale, string> = { uz: "📂 Topshirgan postni ko'rish", ru: "📂 Открыть пост", en: "📂 View post" };
const GRADE_LABEL: Record<Locale, string> = { uz: "🎯 Baholash", ru: "🎯 Оценить", en: "🎯 Grade" };
const RETAG_LABEL: Record<Locale, string> = { uz: "✏️ Vazifani o'zgartirish", ru: "✏️ Изменить задание", en: "✏️ Change task" };

/**
 * A real group-topic post link: https://t.me/c/<chat>/<thread>/<message>. A Mini App / web submission's
 * message_url is a bot deep-link placeholder (https://t.me/<bot>?start=hw_<id>_<attempt>, see submit-homework and
 * reconcile_teacher_dm_queue) — tapping "Open post" for one just opens the bot chat, a dead end (Class F fix,
 * 2026-08-18 review), so it gets no post button.
 */
export function isRealTopicLink(messageUrl: string | null | undefined): boolean {
  return /^https:\/\/t\.me\/c\//.test(messageUrl || "");
}

/**
 * The DM's inline keyboard.
 *   gradeApp null (teacher Mini App off / no private chat) → TODAY's keyboard, byte-identical:
 *     [📂 post?, 🎯 Baholash (gs:open)] · [✏️ retag]?
 *   gradeApp (a web_app button to /tg/teacher/grade?sub=<id>, _shared/teacher-miniapp.ts) →
 *     [🎯 Baholash ↗] · [📂 post?, <chatLabel> (gs:open)] · [✏️ retag]?
 * gs:open:<uuid> = 44 bytes and hwmv:<uuid> = 41, under Telegram's 64-byte callback_data cap.
 */
export function submissionDmKeyboard(loc: Locale, a: {
  submissionId: string;
  messageUrl: string | null | undefined;
  guessed: boolean;
  gradeApp?: Btn | null;
  chatLabel?: string;
}): { inline_keyboard: Btn[][] } {
  const post = isRealTopicLink(a.messageUrl) ? [{ text: POST_LABEL[loc], url: a.messageUrl }] : [];
  const inChat = { text: a.gradeApp ? (a.chatLabel || GRADE_LABEL[loc]) : GRADE_LABEL[loc], callback_data: `gs:open:${a.submissionId}` };
  const retag = a.guessed ? [[{ text: RETAG_LABEL[loc], callback_data: `hwmv:${a.submissionId}` }]] : [];
  if (!a.gradeApp) return { inline_keyboard: [[...post, inChat], ...retag] };
  return { inline_keyboard: [[a.gradeApp], [...post, inChat], ...retag] };
}
