// The student's grade card, for the two edge senders: notify-grade-voice (app / web grades) and
// grade-card-reconcile (the backstop). The bot's own sender (telegram-bot-webhook T.gradeStudentDM) has the same
// text. Before this file the two edge copies were hand-synced duplicates.
//
// All three senders now head the card with the shared hw-label ("5.0 · 1-GURUH PRE · M2 V1 — <title>",
// _shared/hw-label.ts) instead of the bare task title. The Challenge 6.0 tasks are copies of the 5.0 tasks, so a
// student with a late 5.0 grade and a new Challenge grade could not tell the two cards apart (audit FB-3).

export type Locale = "uz" | "ru" | "en";

/** The card. `heading` and `fb` must already be HTML-escaped by the caller. */
export const GRADE_CARD: Record<Locale, (heading: string, sc: number, mx: number, fb: string, xp?: number) => string> = {
  uz: (h, sc, mx, fb, xp) => `🎉 Vazifangiz baholandi!\n\n📝 <b>${h}</b>\nBaho: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nIzoh: ${fb}` : ""}`,
  ru: (h, sc, mx, fb, xp) => `🎉 Ваша работа оценена!\n\n📝 <b>${h}</b>\nОценка: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nКомментарий: ${fb}` : ""}`,
  en: (h, sc, mx, fb, xp) => `🎉 Your homework was graded!\n\n📝 <b>${h}</b>\nScore: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nFeedback: ${fb}` : ""}`,
};

/** Caption of the teacher's voice note (sendAudio, no parse_mode: plain text, NOT escaped). */
export const VOICE_CAPTION: Record<Locale, (heading: string) => string> = {
  uz: (h) => `🎧 "${h}" bo'yicha yangi ovozli izoh — balingizni ko'rish uchun ilovani oching.`,
  ru: (h) => `🎧 Новый голосовой комментарий к "${h}" — откройте приложение, чтобы увидеть оценку.`,
  en: (h) => `🎧 New voice feedback on "${h}" — open the app for your score.`,
};

export const TITLE_FALLBACK: Record<Locale, string> = { uz: "Uy vazifasi", ru: "Домашнее задание", en: "Homework" };

/**
 * What the card is about, as plain text: the hw-label when there is one, else the bare task title (the text the
 * card carried before), else the generic word. Never "".
 */
export function gradeCardHeading(label: string | null | undefined, title: string | null | undefined, locale: Locale): string {
  const l = (label ?? "").trim();
  if (l) return l;
  const t = (title ?? "").trim();
  return t || TITLE_FALLBACK[locale];
}
