// The bot half of the Mini App → bot voice bridge: which pending request a teacher's voice note belongs to.
//
// teacher-voice-request parks one request per submission (_shared/voice-requests.ts) and DMs a prompt naming the
// student. Here a voice note is matched to a request — by the prompt it replies to, or as the only request ever
// pending — and otherwise HELD while the bot asks "who is this for?" with one button per student. Nothing is
// guessed, nothing is re-pointed, and every refusal / question is a DB-visible admin_actions row.
//
// The save + delivery of a matched note stays in index.ts (commitBridgeVoice: scope re-check, homework write,
// sendVoice, the grade_voice_* delivery rows) and is injected as `commit`, so this module has no Telegram or
// grading internals and is tested end to end with a fake DB in voice-bridge.test.ts.
import { logHealth } from "../_shared/edge.ts";
import { botVoiceKey } from "../_shared/grade-card-signals.ts";
import {
  claimHeldVoice, dropHeldVoice, emptyVoiceState, holdVoice, mutateVoiceState, parseVoicePick, pruneVoiceState,
  removeVoiceRequest, resolveVoiceTarget, shortId, VOICE_REQUEST_TTL_MS, type VoiceRequest, voicePickData,
} from "../_shared/voice-requests.ts";
import { replyMidOf } from "./grading-guard.ts";

type Locale = "uz" | "ru" | "en";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type VoiceBridgeDeps = {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** The teacher's profile id (audit rows). */
  actorId: string;
  /** sendMessage (HTML) → the new message_id, or null. */
  send: (chatId: number, text: string, markup?: unknown) => Promise<number | null>;
  /** editMessageText (HTML); best-effort. */
  edit: (chatId: number, messageId: number, text: string, markup?: unknown) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
  /** Save the note on req.submission_id, deliver it, confirm to the teacher (index.ts commitBridgeVoice). */
  commit: (req: VoiceRequest, voice: { file_id: string; key: string | null }, remaining: number) => Promise<void>;
  now?: () => number;
  newToken?: () => string;
};

const COPY = {
  uz: {
    ask: (n: number) => `🎤 Bu ovozli izoh kim uchun? Sizda <b>${n} ta</b> so'rov kutilmoqda — talabani tanlang:`,
    askReply: `🎤 Siz javob bergan xabar kutilayotgan so'rov emas. Bu ovozli izoh kim uchun?`,
    askTip: `💡 Ovozni kerakli talabaning 🎤 so'roviga javob (reply) qilib yuborsangiz, bot so'ramaydi.`,
    discardBtn: "✖️ Saqlamaslik",
    discarded: "✖️ Bu ovoz saqlanmadi.",
    picked: (who: string) => `🎤 → <b>${who}</b>`,
    heldGone: "⌛ Bu ovoz endi kutilmayapti — uni qayta yuboring.",
    reqGone: "Bu so'rov endi kutilmayapti — boshqasini tanlang.",
    noneLeft: "⌛ Kutilayotgan ovozli so'rov qolmadi — bu ovoz saqlanmadi. Mini ilovada «Telegramda ovoz yozish»ni qayta bosing.",
    expired: (who: string) =>
      `⌛ ${who ? `<b>${who}</b> uchun ovozli` : "Ovozli"} izoh so'rovi muddati tugagan, shuning uchun bu ovoz saqlanmadi. Mini ilovada «Telegramda ovoz yozish» tugmasini qayta bosing va ovozni qayta yuboring.`,
    noRequest: "🎤 Bu ovoz saqlanmadi: hozir kutilayotgan ovozli izoh so'rovi yo'q. Mini ilovada talaba kartasida «Telegramda ovoz yozish»ni bosing, so'ng ovozni shu yerga yuboring.",
    tryAgain: "⚠️ Ovozni saqlab bo'lmadi (bir vaqtda bir nechta amal). Iltimos, qayta yuboring.",
    cancelled: (n: number, names: string) => n ? `Bekor qilindi: ${n} ta ovozli so'rov${names ? ` (${names})` : ""}.` : "Bekor qilindi.",
    remaining: (n: number) => `⏳ Yana ${n} ta ovozli so'rov kutilmoqda — har bir ovozni o'sha talaba so'roviga javob qilib yuboring.`,
  },
  ru: {
    ask: (n: number) => `🎤 Для кого этот голосовой комментарий? Ожидает запросов: <b>${n}</b> — выберите студента:`,
    askReply: `🎤 Сообщение, на которое вы ответили, — не ожидающий запрос. Для кого этот голосовой комментарий?`,
    askTip: `💡 Отправляйте голосовое ответом (reply) на 🎤-запрос нужного студента — тогда бот не спрашивает.`,
    discardBtn: "✖️ Не сохранять",
    discarded: "✖️ Это голосовое не сохранено.",
    picked: (who: string) => `🎤 → <b>${who}</b>`,
    heldGone: "⌛ Это голосовое больше не ожидает — отправьте его снова.",
    reqGone: "Этот запрос уже не ожидает — выберите другой.",
    noneLeft: "⌛ Ожидающих запросов не осталось — голосовое не сохранено. Нажмите «Telegramda ovoz yozish» в мини-приложении ещё раз.",
    expired: (who: string) =>
      `⌛ Запрос на голосовой комментарий${who ? ` для <b>${who}</b>` : ""} истёк, поэтому это голосовое не сохранено. Нажмите «Telegramda ovoz yozish» в мини-приложении ещё раз и отправьте его снова.`,
    noRequest: "🎤 Голосовое не сохранено: сейчас нет ожидающего запроса. Нажмите «Telegramda ovoz yozish» на карточке студента в мини-приложении, затем отправьте голосовое сюда.",
    tryAgain: "⚠️ Не удалось сохранить голосовое (несколько действий одновременно). Отправьте его ещё раз.",
    cancelled: (n: number, names: string) => n ? `Отменено запросов на голосовой: ${n}${names ? ` (${names})` : ""}.` : "Отменено.",
    remaining: (n: number) => `⏳ Ещё ожидает запросов: ${n} — отправляйте каждое голосовое ответом на запрос нужного студента.`,
  },
  en: {
    ask: (n: number) => `🎤 Who is this voice feedback for? You have <b>${n}</b> pending requests — pick the student:`,
    askReply: `🎤 The message you replied to is not a pending request. Who is this voice feedback for?`,
    askTip: `💡 Send the voice note as a reply to that student's 🎤 request and the bot won't need to ask.`,
    discardBtn: "✖️ Don't save",
    discarded: "✖️ This voice note was not saved.",
    picked: (who: string) => `🎤 → <b>${who}</b>`,
    heldGone: "⌛ This voice note is no longer waiting — please send it again.",
    reqGone: "That request is no longer pending — pick another.",
    noneLeft: "⌛ No pending voice requests left — this voice note was not saved. Tap «Telegramda ovoz yozish» in the Mini App again.",
    expired: (who: string) =>
      `⌛ The voice feedback request${who ? ` for <b>${who}</b>` : ""} expired, so this voice note wasn't saved. Tap «Telegramda ovoz yozish» in the Mini App again, then resend it.`,
    noRequest: "🎤 This voice note was not saved: there is no pending voice feedback request. Tap «Telegramda ovoz yozish» on the student's card in the Mini App, then send the voice note here.",
    tryAgain: "⚠️ Couldn't save the voice note (several actions at once). Please send it again.",
    cancelled: (n: number, names: string) => n ? `Cancelled ${n} voice request(s)${names ? ` (${names})` : ""}.` : "Cancelled.",
    remaining: (n: number) => `⏳ ${n} more voice request(s) pending — send each note as a reply to that student's request.`,
  },
} as const;

const copy = (locale: Locale) => COPY[locale] ?? COPY.uz;

/** "Aziza Karimova · 5.0 · 1-GURUH PRE · M2 V1" — the label without its title, capped for a button. */
export function pickButtonText(req: VoiceRequest): string {
  const tag = (req.label || "").split(" — ")[0].trim();
  const s = [req.student || "—", tag].filter(Boolean).join(" · ");
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** One button per pending request (oldest first), then "don't save". */
export function pickKeyboard(tok: string, options: VoiceRequest[], locale: Locale) {
  return {
    inline_keyboard: [
      ...options.map((r) => [{ text: `👤 ${pickButtonText(r)}`, callback_data: voicePickData(tok, r.rid) }]),
      [{ text: copy(locale).discardBtn, callback_data: voicePickData(tok, "x") }],
    ],
  };
}

export function askText(reason: "multiple_pending" | "reply_not_pending", n: number, locale: Locale): string {
  const c = copy(locale);
  return `${reason === "reply_not_pending" ? c.askReply : c.ask(n)}\n\n${c.askTip}`;
}

/** The line index.ts appends to the "saved" confirmation when more requests are still waiting. */
export function remainingLine(n: number, locale: Locale): string {
  return n > 0 ? copy(locale).remaining(n) : "";
}

type VoiceOutcome =
  | { kind: "target"; req: VoiceRequest; remaining: number; how: "reply" | "only" }
  | { kind: "ask"; reason: "multiple_pending" | "reply_not_pending"; options: VoiceRequest[] }
  | { kind: "expired"; req: VoiceRequest | null }
  | { kind: "none" };

/**
 * A voice / audio message from a teacher in the bot chat (with or without a grade_voice row). Always consumes
 * the message: it is saved on exactly one request, held behind a "who is this for?" question, or refused with
 * a message that says it was NOT saved — never dropped into the generic keyboard hint.
 */
export async function onBridgeVoice(
  d: VoiceBridgeDeps,
  // deno-lint-ignore no-explicit-any
  msg: any,
  locale: Locale,
): Promise<void> {
  const chatId = Number(msg.chat.id);
  const tgId = Number(msg.from.id);
  const fileId: string | null = msg.voice?.file_id || msg.audio?.file_id || null;
  if (!fileId) return;
  const key = botVoiceKey(msg);
  const replyMid = replyMidOf(msg);
  const sentAtMs = typeof msg.date === "number" ? (msg.date + 1) * 1000 : null;
  const tok = (d.newToken ?? shortId)();
  const out = await mutateVoiceState<VoiceOutcome>(d.admin, tgId, (cur, _row, nowMs) => {
    if (!cur) return { abort: { kind: "none" } };
    const t = resolveVoiceTarget(cur, replyMid, nowMs, sentAtMs);
    const base = pruneVoiceState(cur, nowMs);
    if (t.kind === "target") {
      // Claim the request in the same write that reads it: a second note racing this one finds it gone.
      const next = removeVoiceRequest(base, t.req.rid);
      return { write: next, result: { kind: "target", req: t.req, remaining: next.reqs.length, how: t.how } };
    }
    if (t.kind === "ask") {
      const held = holdVoice(base, {
        tok, file_id: fileId, key, mid: typeof msg.message_id === "number" ? msg.message_id : null,
        at: new Date(nowMs).toISOString(), exp: new Date(nowMs + VOICE_REQUEST_TTL_MS).toISOString(),
      });
      return { write: held.state, result: { kind: "ask", reason: t.reason, options: t.options } };
    }
    if (t.kind === "expired") return { write: base, result: { kind: "expired", req: t.req } };
    return { abort: { kind: "none" } };
  }, { now: d.now });

  const c = copy(locale);
  if (!out.ok) {
    await d.send(chatId, c.tryAgain);
    await logHealth(d.admin, "grade_voice_unrouted", { reason: out.reason, error: out.error ?? null, voice_key: key }, {
      source: "miniapp_voice_bridge", actorUserId: d.actorId,
    });
    return;
  }
  const r = out.result;
  if (r.kind === "target") {
    await d.commit(r.req, { file_id: fileId, key }, r.remaining);
    return;
  }
  if (r.kind === "ask") {
    await d.send(chatId, askText(r.reason, r.options.length, locale), pickKeyboard(tok, r.options, locale));
    // Countable: how often a teacher records without saying for whom (the bridge's ambiguity rate).
    await logHealth(d.admin, "grade_voice_target_asked", { reason: r.reason, pending: r.options.length, voice_key: key }, {
      source: "miniapp_voice_bridge", actorUserId: d.actorId,
    });
    return;
  }
  if (r.kind === "expired") {
    await d.send(chatId, c.expired(r.req?.student ? esc(r.req.student) : ""));
    await logHealth(d.admin, "grade_voice_request_expired", { voice_key: key }, {
      source: "miniapp_voice_bridge", actorUserId: d.actorId,
      targetResourceType: r.req ? "homework_submission" : null, targetResourceId: r.req?.submission_id ?? null,
    });
    return;
  }
  await d.send(chatId, c.noRequest);
  await logHealth(d.admin, "grade_voice_unrouted", { reason: "no_request", reply: replyMid != null, voice_key: key }, {
    source: "miniapp_voice_bridge", actorUserId: d.actorId,
  });
}

/** /cancel while voice requests are pending: withdraw all of them (and any held recordings). */
export async function cancelVoiceRequests(
  d: VoiceBridgeDeps, tgId: number, locale: Locale,
): Promise<string> {
  const out = await mutateVoiceState<{ n: number; names: string }>(d.admin, tgId, (cur, _row, nowMs) => {
    if (!cur) return { abort: { n: 0, names: "" } };
    const live = pruneVoiceState(cur, nowMs).reqs;
    const names = live.map((r) => r.student ? `<b>${esc(r.student)}</b>` : "").filter(Boolean).join(", ");
    return { write: emptyVoiceState(), result: { n: live.length, names } };
  }, { now: d.now });
  const r = out.ok ? out.result : { n: 0, names: "" };
  return copy(locale).cancelled(r.n, r.names);
}

type PickOutcome =
  | { kind: "picked"; req: VoiceRequest; file_id: string; key: string | null; remaining: number }
  | { kind: "held_gone" }
  | { kind: "req_gone"; options: VoiceRequest[] }
  | { kind: "discarded" };

/**
 * The teacher tapped a student (or "don't save") on a "who is this for?" question. The question lives in her
 * private bot chat and the state is read by the tapper's own telegram_id, so nobody else can answer it.
 */
export async function onVoicePick(
  d: VoiceBridgeDeps,
  // deno-lint-ignore no-explicit-any
  cq: any,
  locale: Locale,
): Promise<void> {
  const c = copy(locale);
  const p = parseVoicePick(String(cq.data || ""));
  const chatId = Number(cq.message?.chat?.id);
  const qMid: number | null = typeof cq.message?.message_id === "number" ? cq.message.message_id : null;
  const tgId = Number(cq.from?.id);
  if (!p || !chatId || chatId !== tgId) { await d.answer(cq.id); return; }

  const out = await mutateVoiceState<PickOutcome>(d.admin, tgId, (cur, _row, nowMs) => {
    if (!cur) return { abort: { kind: "held_gone" } };
    if (p.rid === "x") {
      if (!cur.held.some((h) => h.tok === p.tok)) return { abort: { kind: "held_gone" } };
      return { write: pruneVoiceState(dropHeldVoice(cur, p.tok), nowMs), result: { kind: "discarded" } };
    }
    const cl = claimHeldVoice(cur, p.tok, p.rid, nowMs);
    if (!cl.ok && cl.reason === "held_gone") return { abort: { kind: "held_gone" } };
    if (!cl.ok) {
      // That student's request was answered (or expired) since the question was asked. With others still
      // pending, ask again among them; with none left, the held note has nowhere to go — drop it and say so.
      if (cl.options.length) return { abort: { kind: "req_gone", options: cl.options } };
      return { write: pruneVoiceState(dropHeldVoice(cur, p.tok), nowMs), result: { kind: "req_gone", options: [] } };
    }
    const next = pruneVoiceState(cl.state, nowMs);
    return {
      write: next,
      result: { kind: "picked", req: cl.req, file_id: cl.held.file_id, key: cl.held.key, remaining: next.reqs.length },
    };
  }, { now: d.now });

  if (!out.ok) { await d.answer(cq.id, c.tryAgain); return; }
  const r = out.result;
  if (r.kind === "discarded") {
    await d.answer(cq.id);
    if (qMid) await d.edit(chatId, qMid, c.discarded);
    await logHealth(d.admin, "grade_voice_unrouted", { reason: "discarded_by_teacher" }, {
      source: "miniapp_voice_bridge", actorUserId: d.actorId,
    });
    return;
  }
  if (r.kind === "held_gone") {
    await d.answer(cq.id, c.heldGone);
    if (qMid) await d.edit(chatId, qMid, c.heldGone);
    return;
  }
  if (r.kind === "req_gone") {
    await d.answer(cq.id, c.reqGone);
    if (qMid) {
      if (r.options.length) await d.edit(chatId, qMid, askText("multiple_pending", r.options.length, locale), pickKeyboard(p.tok, r.options, locale));
      else await d.edit(chatId, qMid, c.noneLeft);
    }
    if (!r.options.length) {
      await logHealth(d.admin, "grade_voice_unrouted", { reason: "no_request_left" }, {
        source: "miniapp_voice_bridge", actorUserId: d.actorId,
      });
    }
    return;
  }
  await d.answer(cq.id);
  if (qMid) await d.edit(chatId, qMid, c.picked(esc(r.req.student || "—")));
  await d.commit(r.req, { file_id: r.file_id, key: r.key }, r.remaining);
}
