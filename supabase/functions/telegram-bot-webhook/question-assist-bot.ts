// 🤖 The question assistant's buttons (question-assistant edge function; migration 20261011072000):
//   qa:s:<q>  ✅ Yuborish   — a curator posts the trial draft into the topic as «🤖 Yordamchi» (once; claimed)
//   qa:x:<q>  ❌ Kerak emas — a curator drops the draft
//   qa:n:<q>  ❌ Yordam bermadi — the STUDENT who asked hands the question back: it reopens and the curators are told
// qa:s / qa:x: the real clicker must be a teacher/admin of the question's group (index.ts checks persona +
// impersonation; the group is re-checked here — callback data is client-supplied). qa:n: only the asker's Telegram id.

import { logHealth } from "../_shared/edge.ts";
import { escCap } from "../_shared/support-agent-card.ts";
import type { SupportDeps } from "./support.ts";
import { type TqViewer, viewerGroups } from "./teacher-questions-bot.ts";

type Db = any;
export type QaCallback = { kind: "send" | "reject" | "not_helped"; id: number };

export function parseQaCallback(data: string): QaCallback | null {
  const m = /^qa:([sxn]):(\d{1,12})$/.exec(String(data ?? ""));
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: m[1] === "s" ? "send" : m[1] === "x" ? "reject" : "not_helped", id };
}

const REPLY_FOOTER = "\n\n<i>Yordam bermasa — pastdagi tugmani bosing, kurator javob beradi.</i>";
const HELP_BUTTON = (id: number) => ({ inline_keyboard: [[{ text: "❌ Yordam bermadi", callback_data: `qa:n:${id}` }]] });

async function curatorChats(admin: Db, groupId: string): Promise<number[]> {
  const [{ data: g }, { data: gt }] = await Promise.all([
    admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle(),
    admin.from("group_teachers").select("teacher_id").eq("group_id", groupId),
  ]);
  const ids = Array.from(new Set([g?.teacher_id, ...((gt ?? []) as any[]).map((r) => r.teacher_id)].filter(Boolean)));
  if (!ids.length) return [];
  const { data: ps } = await admin.from("profiles").select("telegram_id, telegram_write_access_at").in("id", ids);
  return ((ps ?? []) as any[]).filter((p) => p.telegram_write_access_at && Number(p.telegram_id)).map((p) => Number(p.telegram_id));
}

async function clearCards(deps: SupportDeps, cards: unknown, note: string) {
  for (const c of (Array.isArray(cards) ? cards : []) as Array<{ chat: number; msg: number }>) {
    if (!c?.chat || !c?.msg) continue;
    await deps.call("editMessageReplyMarkup", { chat_id: c.chat, message_id: c.msg, reply_markup: { inline_keyboard: [[{ text: note, callback_data: "qa:noop" }]] } });
  }
}

export async function handleQaCallback(admin: Db, cb: QaCallback, ctx: {
  tgId: number; chatId: number; messageId: number | null; viewer: TqViewer | null; answer: (text?: string) => Promise<void>;
}, deps: SupportDeps) {
  const { data: q } = await admin.from("teacher_questions")
    .select("id, group_id, chat_id, thread_id, tg_user_id, first_message_id, student_name, status, answered_via").eq("id", cb.id).maybeSingle();
  const { data: a } = await admin.from("question_assist")
    .select("question_id, status, draft_html, curator_messages, feedback").eq("question_id", cb.id).maybeSingle();
  if (!q || !a) { await ctx.answer("Topilmadi"); return; }

  // ── the student: «❌ Yordam bermadi» ──
  if (cb.kind === "not_helped") {
    if (Number(q.tg_user_id) !== Number(ctx.tgId)) { await ctx.answer("Bu tugma savol egasi uchun 🙂"); return; }
    if (a.feedback) { await ctx.answer("Kurator allaqachon xabardor 🙏"); return; }
    await admin.from("question_assist").update({ feedback: "not_helped" }).eq("question_id", q.id);
    await admin.from("teacher_questions")
      .update({ status: "open", answered_at: null, answered_by: null, answered_via: null, answer_message_id: null })
      .eq("id", q.id).eq("answered_via", "assistant");
    if (ctx.messageId) await deps.call("editMessageReplyMarkup", { chat_id: ctx.chatId, message_id: ctx.messageId, reply_markup: { inline_keyboard: [] } });
    const chats = await curatorChats(admin, q.group_id);
    for (const c of chats) {
      await deps.call("sendMessage", {
        chat_id: c, parse_mode: "HTML",
        text: `↩️ <b>#${q.id}</b> · ${escCap(q.student_name || "Oʻquvchi", 60)}: yordamchining javobi yordam bermadi — savol sizga qaytdi.`,
        reply_markup: { inline_keyboard: [[{ text: "📂 Savolni ochish", callback_data: `tq:o:${q.id}` }]] },
      });
    }
    await logHealth(admin, "question_assistant_not_helped", { question_id: q.id, curators: chats.length }, { source: "telegram-bot-webhook" });
    await ctx.answer("Rahmat! Kurator koʻrib chiqadi 🙏");
    return;
  }

  // ── a curator: ✅ / ❌ on a trial draft ──
  if (!ctx.viewer) { await ctx.answer("⛔"); return; }
  const groups = await viewerGroups(admin, ctx.viewer);
  if (!groups.some((g) => g.id === q.group_id)) { await ctx.answer("⛔ Bu savol sizning guruhingizdan emas"); return; }

  if (cb.kind === "reject") {
    const { data: r } = await admin.from("question_assist").update({ status: "rejected", decided_by: ctx.viewer.id, decided_at: new Date().toISOString() })
      .eq("question_id", q.id).eq("status", "drafted").select("question_id");
    await clearCards(deps, a.curator_messages, Array.isArray(r) && r.length ? "❌ Kerak emas" : "Allaqachon hal qilingan");
    await ctx.answer(Array.isArray(r) && r.length ? "❌ Bekor qilindi" : "Allaqachon hal qilingan");
    return;
  }

  // send: claim the draft once, then post it
  const { data: claimed } = await admin.from("question_assist").update({ status: "approved", decided_by: ctx.viewer.id, decided_at: new Date().toISOString() })
    .eq("question_id", q.id).eq("status", "drafted").select("question_id");
  if (!Array.isArray(claimed) || !claimed.length) { await ctx.answer("Allaqachon hal qilingan"); return; }
  const posted = await deps.call("sendMessage", {
    chat_id: q.chat_id, message_thread_id: q.thread_id, parse_mode: "HTML", disable_web_page_preview: true,
    text: `🤖 <b>Yordamchi</b>\n\n${a.draft_html}${REPLY_FOOTER}`, reply_markup: HELP_BUTTON(q.id),
    reply_parameters: { message_id: q.first_message_id, allow_sending_without_reply: true },
  });
  const mid = Number(posted.result?.message_id);
  if (!posted.ok || !Number.isSafeInteger(mid)) {
    await admin.from("question_assist").update({ status: "drafted", decided_by: null, decided_at: null }).eq("question_id", q.id);
    await logHealth(admin, "question_assistant_post_failed", { question_id: q.id, error: posted.error }, { source: "telegram-bot-webhook" });
    await ctx.answer("⚠️ Guruhga yuborilmadi — qayta urinib koʻring");
    return;
  }
  await admin.from("question_assist").update({ reply_message_id: mid }).eq("question_id", q.id);
  await admin.from("teacher_questions").update({
    status: "answered", answered_at: new Date().toISOString(), answered_by: ctx.viewer.id, answered_via: "assistant", answer_message_id: mid,
  }).eq("id", q.id).eq("status", "open");
  await clearCards(deps, a.curator_messages, "✅ Yuborildi");
  await ctx.answer("✅ Guruhga yuborildi");
}
