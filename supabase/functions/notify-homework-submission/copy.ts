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
