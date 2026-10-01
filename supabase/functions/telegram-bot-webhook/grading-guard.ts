// One grading target at a time in the bot (teacher audit 2026-09-30, BOT-4 / R8).
//
// The bot keeps ONE conversation row per teacher (bot_conversation_state, PK telegram_id). Three slips could put
// a grade or a comment on the wrong student, and none of them said so:
//   1. Opening a second homework (🎯) silently replaced the one she was grading — 34 times in 90 days
//      (webhook_inbox, 2026-09-30: 28 before a score was typed, 6 between score and comment), and it silently
//      dropped pending Mini App voice requests too.
//   2. A reply to an OLDER message (scrolled up to the previous student's prompt) still graded the current one.
//   3. parseInt read free text: "1 vazifa topilmadi" ("task 1 not found") was saved as a score of 1.
// This module is the pure half of the fix (copy + decisions, tested in grading-guard.test.ts); index.ts calls it
// where the session is opened and where a score / comment is read.
import { gradeWhoLine } from "./hw-labels.ts";
import { normalizeVoiceState } from "../_shared/voice-requests.ts";

type Locale = "uz" | "ru" | "en";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * A score is a plain whole number and nothing else. /^\d+$/ after trimming: "8" → 8; "8 yaxshi", "1 vazifa
 * topilmadi", "8.5", "-1" are refused (the comment is its own step). Range-checked against the task's max.
 */
export function parseStrictScore(
  text: string, max: number,
): { ok: true; score: number } | { ok: false; reason: "not_a_number" | "out_of_range" } {
  const s = (text || "").trim();
  if (!/^\d+$/.test(s)) return { ok: false, reason: "not_a_number" };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) return { ok: false, reason: "out_of_range" };
  return { ok: true, score: n };
}

/**
 * The message a teacher's message replies to, or null. A forum-topic post carries an implicit reply to the
 * topic-creation message (capture-signals.isRealReply) — that is not a real reply.
 */
// deno-lint-ignore no-explicit-any
export function replyMidOf(msg: any): number | null {
  const r = msg?.reply_to_message;
  if (!r || r.forum_topic_created) return null;
  return typeof r.message_id === "number" ? r.message_id : null;
}

/**
 * Score / comment input bound to the session: message ids in the teacher's bot chat only grow, and the session
 * remembers the id of its first message (the header naming the student). A reply to anything OLDER points at an
 * earlier student's screen — refuse it rather than grade the current student. No reply, or a reply to this
 * session's own messages (header, media, prompt), is accepted. A session without an anchor (opened before this
 * change, or by the retag path for another homework) binds nothing.
 */
export function replyPointsElsewhere(replyMid: number | null, anchorMid: unknown): boolean {
  return replyMid != null && typeof anchorMid === "number" && Number.isInteger(anchorMid) && replyMid < anchorMid;
}

/** The session row as read from bot_conversation_state (loosely typed jsonb context). */
export type SessionRow = { state: string; context: unknown; updated_at?: string; expires_at: string } | null;

export type ReplacedNotice = {
  text: string;
  details: {
    from_state: string;
    from_submission_id: string | null;
    had_score: boolean;
    voice_requests: number;
    held_voices: number;
  };
};

const COPY = {
  uz: {
    replacedGrading: (who: string, score: number | null) =>
      `⚠️ Tugallanmagan baholash bekor qilindi${score != null ? ` (kiritilgan baho ${score} saqlanmadi)` : ""}${who ? `:\n${who}` : "."}`,
    replacedSelf: (score: number) => `ℹ️ Kiritilgan baho (${score}) bekor qilindi — bahoni qaytadan kiriting.`,
    replacedVoice: (names: string, n: number, held: number) =>
      (n ? `⚠️ Kutilayotgan ${n} ta ovozli izoh so'rovi bekor qilindi${names ? `: ${names}` : ""}.` : "⚠️") +
      (held ? ` Talabasi tanlanmagan ${held} ta ovoz saqlanmadi.` : "") +
      ` Kerak bo'lsa, Mini ilovada «Telegramda ovoz yozish»ni qayta bosing.`,
    notANumber: (max: number) => `⚠️ Bahoga faqat raqam yozing (0–${max}), masalan: 8. Izohni keyingi qadamda yozasiz.`,
    replyElsewhere: (who: string) =>
      `⚠️ Siz oldingi xabarga javob (reply) qildingiz — u boshqa talabaga tegishli bo'lishi mumkin, shuning uchun saqlanmadi.` +
      (who ? `\nHozir baholanayotgan: ${who}` : "") +
      `\nShu talaba uchun javobsiz yozing yoki kerakli talabaning 🎯 tugmasini qayta bosing.`,
  },
  ru: {
    replacedGrading: (who: string, score: number | null) =>
      `⚠️ Незавершённая проверка отменена${score != null ? ` (введённый балл ${score} не сохранён)` : ""}${who ? `:\n${who}` : "."}`,
    replacedSelf: (score: number) => `ℹ️ Введённый балл (${score}) отменён — введите его заново.`,
    replacedVoice: (names: string, n: number, held: number) =>
      (n ? `⚠️ Отменено ожидающих запросов на голосовой комментарий: ${n}${names ? ` (${names})` : ""}.` : "⚠️") +
      (held ? ` Не сохранено голосовых без выбранного студента: ${held}.` : "") +
      ` Если нужно, нажмите «Telegramda ovoz yozish» в мини-приложении ещё раз.`,
    notANumber: (max: number) => `⚠️ В балл пишите только число (0–${max}), например: 8. Комментарий — на следующем шаге.`,
    replyElsewhere: (who: string) =>
      `⚠️ Вы ответили (reply) на более раннее сообщение — оно может относиться к другому студенту, поэтому ничего не сохранено.` +
      (who ? `\nСейчас проверяется: ${who}` : "") +
      `\nНапишите без ответа или снова нажмите 🎯 у нужного студента.`,
  },
  en: {
    replacedGrading: (who: string, score: number | null) =>
      `⚠️ Unfinished grading cancelled${score != null ? ` (the score you entered, ${score}, was not saved)` : ""}${who ? `:\n${who}` : "."}`,
    replacedSelf: (score: number) => `ℹ️ The score you entered (${score}) was discarded — enter it again.`,
    replacedVoice: (names: string, n: number, held: number) =>
      (n ? `⚠️ Cancelled ${n} pending voice feedback request(s)${names ? `: ${names}` : ""}.` : "⚠️") +
      (held ? ` ${held} recording(s) without a chosen student were not saved.` : "") +
      ` If needed, tap «Telegramda ovoz yozish» in the Mini App again.`,
    notANumber: (max: number) => `⚠️ Type only a number as the score (0–${max}), e.g. 8. The comment is the next step.`,
    replyElsewhere: (who: string) =>
      `⚠️ You replied to an earlier message — it may belong to another student, so nothing was saved.` +
      (who ? `\nNow grading: ${who}` : "") +
      `\nType without replying, or tap 🎯 on the right student again.`,
  },
} as const;

/**
 * Opening a grading session for `sameSubmissionIds[0]` replaces whatever the row holds. Say so when that loses
 * something: an unfinished grade_score / grade_comment for ANOTHER homework (with the score already typed, if
 * any), a re-open of the same homework that discards a typed score, or pending Mini App voice requests. null
 * when nothing is lost (no row, expired, a non-grading state, or the same homework with nothing typed).
 */
export function replacedSessionNotice(
  row: SessionRow, sameSubmissionIds: readonly string[], nowMs: number, locale: Locale,
): ReplacedNotice | null {
  if (!row) return null;
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) return null;
  const c = COPY[locale] ?? COPY.uz;
  const ctx = (row.context && typeof row.context === "object") ? row.context as Record<string, unknown> : {};
  if (row.state === "grade_score" || row.state === "grade_comment") {
    const from = str(ctx.submission_id) || null;
    const score = row.state === "grade_comment" && typeof ctx.score === "number" ? ctx.score : null;
    const details = { from_state: row.state, from_submission_id: from, had_score: score != null, voice_requests: 0, held_voices: 0 };
    if (from && sameSubmissionIds.includes(from)) {
      return score != null ? { text: c.replacedSelf(score), details } : null;
    }
    const who = gradeWhoLine(str(ctx.student_name), str(ctx.who_tag));
    return { text: c.replacedGrading(who, score), details };
  }
  if (row.state === "grade_voice") {
    const s = normalizeVoiceState(row.context, row.updated_at ?? row.expires_at, row.expires_at);
    const reqs = s.reqs.filter((r) => Date.parse(r.exp) > nowMs);
    const held = s.held.filter((h) => Date.parse(h.exp) > nowMs).length;
    if (!reqs.length && !held) return null;
    const names = reqs.map((r) => r.student ? `<b>${esc(r.student)}</b>` : "").filter(Boolean).join(", ");
    return {
      text: c.replacedVoice(names, reqs.length, held),
      details: { from_state: "grade_voice", from_submission_id: null, had_score: false, voice_requests: reqs.length, held_voices: held },
    };
  }
  return null;
}

/** "Type only a number" with the who-line, so the refusal still says whose score it is waiting for. */
export function notANumberText(locale: Locale, max: number): string {
  return (COPY[locale] ?? COPY.uz).notANumber(max);
}

/** The reply-to-an-older-message refusal, naming the student the session is on (when known). */
export function replyElsewhereText(locale: Locale, studentName: unknown, whoTag: unknown): string {
  return (COPY[locale] ?? COPY.uz).replyElsewhere(gradeWhoLine(str(studentName), str(whoTag)));
}

/** message_id of a sendMessage Response, or null (never throws). */
export async function messageIdOf(resp: Response | null | undefined): Promise<number | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const j: any = await resp?.json();
    const id = j?.result?.message_id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}
