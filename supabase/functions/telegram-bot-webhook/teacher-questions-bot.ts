// ❓ «KURATORGA SAVOLLAR» in the teacher's bot: the inbox (❓ Savollar / /savollar), the question card, ✍️ answering
// from the bot and ✅ closing. Rows: public.teacher_questions (migration 20261010051000); rendering:
// _shared/teacher-questions.ts. The caller (index.ts) has already checked that the REAL clicker is a teacher or an
// admin and is not impersonating; every question action here re-checks that the question's group is one of the
// viewer's (callback data is client-supplied).
//
// ✍️ Javob yozish → bot_conversation_state 'awaiting_tq_answer' (15 min) → the teacher's next message (text, photo,
// voice, video, file, GIF, sticker, or an ALBUM) is posted in the group's questions topic as a REPLY to the student's
// question, headed «💬 Kurator javobi», and sent to the student in a DM when the bot can write to them.
// The wait ends on: a reply-keyboard button, a /command, or ANY other inline-button tap (index.ts clears the state on
// every callback except tq:r) — so an unrelated later message can never be posted to the group by accident.
// Albums: the first part CLAIMS the state (one UPDATE … WHERE state = 'awaiting_tq_answer' RETURNING → 'tq_answer_album'
// with its media_group_id, 2 min); the other parts of the same album are copied under the answer.
// A failed post is DB-visible (teacher_question_answer_failed) and the question stays open.

import { logHealth } from "../_shared/edge.ts";
import {
  bucketizeTq, messageLink, renderTqList, renderTqSummary, TQ_COLUMNS, tqAnswerHead, tqCard, tqCardKeyboard,
  type TqCallback, type TqRow, tqSettingsOf, tqStudentDm,
} from "../_shared/teacher-questions.ts";
import { escapeCapped, mediaKind, messageText, type SupportDeps } from "./support.ts";

type Db = any;
export type TqViewer = { id: string; isAdmin: boolean };
export const TQ_ANSWER_STATE = "awaiting_tq_answer";
export const TQ_ALBUM_STATE = "tq_answer_album";
const TQ_TTL_MS = 15 * 60_000;
const TQ_ALBUM_MS = 2 * 60_000;
const NO_CAPTION = new Set(["video_note", "sticker"]);
const TEXT_MAX = 3800;

/** support.ts mediaKind + the two kinds a teacher may also answer with (a GIF, a sticker). */
function answerKind(msg: any): string | null {
  return mediaKind(msg) ?? (msg?.animation ? "animation" : msg?.sticker ? "sticker" : null);
}

/** The groups this viewer sees: their own (primary ∪ co-teacher) that have a questions topic; an admin sees all such. */
export async function viewerGroups(admin: Db, viewer: TqViewer): Promise<Array<{ id: string; name: string }>> {
  let ids: string[] | null = null;
  if (!viewer.isAdmin) {
    const [{ data: prim }, { data: gt }] = await Promise.all([
      admin.from("groups").select("id").eq("teacher_id", viewer.id),
      admin.from("group_teachers").select("group_id").eq("teacher_id", viewer.id),
    ]);
    ids = Array.from(new Set([...((prim ?? []) as any[]).map((g) => g.id), ...((gt ?? []) as any[]).map((r) => r.group_id)]));
    if (!ids.length) return [];
  }
  let q = admin.from("groups").select("id, name").not("questions_thread_id", "is", null);
  if (ids) q = q.in("id", ids);
  const { data, error } = await q.order("name");
  if (error) throw new Error(`groups: ${String(error.message ?? error).slice(0, 200)}`);
  return (data ?? []) as Array<{ id: string; name: string }>;
}

async function settings(admin: Db) {
  const { data } = await admin.from("platform_settings").select("value").eq("key", "teacher_questions").maybeSingle();
  return tqSettingsOf(data?.value);
}

async function openRows(admin: Db, groupIds: string[]): Promise<TqRow[]> {
  if (!groupIds.length) return [];
  const { data, error } = await admin.from("teacher_questions").select(TQ_COLUMNS)
    .eq("status", "open").in("group_id", groupIds).order("asked_at", { ascending: true }).limit(500);
  if (error) throw new Error(`teacher_questions: ${String(error.message ?? error).slice(0, 200)}`);
  return (data ?? []) as TqRow[];
}

async function show(deps: SupportDeps, chatId: number, messageId: number | null, r: { text: string; keyboard: unknown }) {
  if (messageId) {
    const e = await deps.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: r.keyboard,
    });
    if (e.ok || /not modified/i.test(e.error ?? "")) return;
  }
  await deps.call("sendMessage", { chat_id: chatId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: r.keyboard });
}

async function failed(admin: Db, deps: SupportDeps, chatId: number, e: unknown, where: string) {
  await logHealth(admin, "teacher_questions_inbox_failed", { where, error: String((e as any)?.message ?? e).slice(0, 200) },
    { source: "telegram-bot-webhook" });
  await deps.call("sendMessage", { chat_id: chatId, text: "⚠️ Savollarni hozir ochib boʻlmadi. Birozdan keyin qayta urinib koʻring." });
}

/** ❓ Savollar: the summary (all of the viewer's groups, or one with `gid`). */
export async function sendTqSummary(admin: Db, chatId: number, viewer: TqViewer, deps: SupportDeps,
  messageId: number | null = null, gid: string | null = null) {
  try {
    const groups = await viewerGroups(admin, viewer);
    if (!groups.length) {
      await deps.call("sendMessage", { chat_id: chatId, text: "Sizning guruhlaringizda «Kuratorga savollar» mavzusi hali ulanmagan." });
      return;
    }
    const s = await settings(admin);
    const rows = await openRows(admin, groups.map((g) => g.id));
    const scope = gid && groups.some((g) => g.id === gid) ? gid : null;
    const now = Date.now();
    const b = bucketizeTq(scope ? rows.filter((r) => r.group_id === scope) : rows, now, s.new_min);
    const counts = groups.map((g) => ({ ...g, open: rows.filter((r) => r.group_id === g.id).length }));
    await show(deps, chatId, messageId, renderTqSummary(b, now, s, counts, scope));
  } catch (e) {
    await failed(admin, deps, chatId, e, "summary");
  }
}

async function loadQuestion(admin: Db, id: number): Promise<TqRow | null> {
  const { data } = await admin.from("teacher_questions").select(TQ_COLUMNS).eq("id", id).maybeSingle();
  return (data as TqRow) ?? null;
}

/** The question card + its screenshots / files copied under it. */
async function sendCard(admin: Db, chatId: number, q: TqRow, groupName: string | null, deps: SupportDeps) {
  const card = await deps.call("sendMessage", {
    chat_id: chatId, parse_mode: "HTML", disable_web_page_preview: true,
    text: tqCard(q, Date.now(), groupName), reply_markup: tqCardKeyboard(q),
  });
  const cardId = Number(card.result?.message_id);
  if (!card.ok || !Number.isSafeInteger(cardId)) {
    await logHealth(admin, "teacher_questions_inbox_failed", { where: "card", question_id: q.id, error: card.error },
      { source: "telegram-bot-webhook" });
    return;
  }
  let copyFailed = 0;
  for (const m of (q.media ?? []).slice(0, 10)) {
    const cp = await deps.call("copyMessage", {
      chat_id: chatId, from_chat_id: q.chat_id, message_id: m.message_id,
      reply_parameters: { message_id: cardId, allow_sending_without_reply: true },
    });
    if (!cp.ok) copyFailed++;
  }
  if (copyFailed) {
    await deps.call("sendMessage", {
      chat_id: chatId, text: `📎 ${copyFailed} ta fayl koʻchirilmadi — «🔗 Guruhda koʻrish» orqali oching.`,
      reply_parameters: { message_id: cardId, allow_sending_without_reply: true },
    });
  }
}

export async function handleTqCallback(admin: Db, cb: TqCallback,
  ctx: { chatId: number; messageId: number | null; viewer: TqViewer; tgId: number }, deps: SupportDeps) {
  const { chatId, viewer } = ctx;
  if (cb.kind === "summary") return sendTqSummary(admin, chatId, viewer, deps, ctx.messageId, cb.gid);
  try {
    const groups = await viewerGroups(admin, viewer);
    const names: Record<string, string> = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    if (cb.kind === "list") {
      const s = await settings(admin);
      const scope = cb.gid && names[cb.gid] ? cb.gid : null;
      const rows = await openRows(admin, scope ? [scope] : groups.map((g) => g.id));
      const now = Date.now();
      const b = bucketizeTq(rows, now, s.new_min);
      return show(deps, chatId, ctx.messageId, renderTqList(cb.bucket, cb.bucket === "n" ? b.fresh : b.old, cb.page, now, names, scope));
    }
    const q = await loadQuestion(admin, cb.id);
    if (!q) {
      await deps.call("sendMessage", { chat_id: chatId, text: `⚠️ Savol #${cb.id} topilmadi.` });
      return;
    }
    if (!names[q.group_id]) {
      await deps.call("sendMessage", { chat_id: chatId, text: "⛔ Bu savol sizning guruhingizdan emas." });
      return;
    }
    if (cb.kind === "open") return sendCard(admin, chatId, q, names[q.group_id], deps);
    if (cb.kind === "reply") return startTqAnswer(admin, chatId, ctx.tgId, q, deps);
    if (cb.kind === "done") {
      const { data } = await admin.from("teacher_questions")
        .update({ status: "answered", answered_at: new Date().toISOString(), answered_by: viewer.id, answered_via: "manual" })
        .eq("id", q.id).eq("status", "open").select("id");
      const done = Array.isArray(data) && data.length > 0;
      await deps.call("sendMessage", {
        chat_id: chatId, parse_mode: "HTML",
        text: done ? `✅ Savol <b>#${q.id}</b> javob berilgan deb belgilandi.` : `Savol <b>#${q.id}</b> allaqachon yopilgan.`,
        reply_markup: { inline_keyboard: [[
          ...(done ? [{ text: "↩️ Qaytarish", callback_data: `tq:u:${q.id}` }] : []),
          { text: "❓ Savollar", callback_data: "tq:s" },
        ]] },
      });
      return;
    }
    // undo — only a manual ✅ is undone (a real answer stays answered)
    const { data } = await admin.from("teacher_questions")
      .update({ status: "open", answered_at: null, answered_by: null, answered_via: null })
      .eq("id", q.id).eq("status", "answered").eq("answered_via", "manual").select("id");
    await deps.call("sendMessage", {
      chat_id: chatId, parse_mode: "HTML",
      text: Array.isArray(data) && data.length ? `↩️ Savol <b>#${q.id}</b> yana ochiq.` : `Savol <b>#${q.id}</b> qaytarilmadi (unga javob berilgan).`,
    });
  } catch (e) {
    await failed(admin, deps, chatId, e, cb.kind);
  }
}

/** ✍️ Javob yozish: the teacher's next message is the answer. */
export async function startTqAnswer(admin: Db, chatId: number, tgId: number, q: TqRow, deps: SupportDeps) {
  const { data: prev } = await admin.from("bot_conversation_state").select("state, expires_at").eq("telegram_id", tgId).maybeSingle();
  const replaced = prev && prev.state !== TQ_ANSWER_STATE && prev.state !== TQ_ALBUM_STATE && !!prev.expires_at &&
      Date.parse(prev.expires_at) > Date.now()
    ? `\n\n<i>(Oldin kutilayotgan amal — ${escapeCapped(String(prev.state), 60)} — bekor qilindi.)</i>` : "";
  await admin.from("bot_conversation_state").upsert({
    telegram_id: tgId, state: TQ_ANSWER_STATE, context: { question_id: q.id },
    updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + TQ_TTL_MS).toISOString(),
  });
  const who = escapeCapped(q.student_name || (q.student_username ? `@${q.student_username}` : "oʻquvchi"), 80);
  await deps.call("sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `✍️ <b>#${q.id}</b> — ${who} uchun javobingizni yozing (matn, rasm, ovozli xabar yoki fayl).\n\n` +
      "Javob guruhdagi savolga <b>reply</b> boʻlib chiqadi va oʻquvchiga botda ham yuboriladi.\n" +
      "<i>Bekor qilish: istalgan tugmani bosing yoki /cancel yozing.</i>" + replaced,
  });
}

/** The teacher's message while 'awaiting_tq_answer'. true = consumed. */
export async function captureTqAnswer(admin: Db, msg: any, viewer: TqViewer, deps: SupportDeps): Promise<boolean> {
  const tgId = Number(msg?.from?.id);
  const albumId: string | null = typeof msg?.media_group_id === "string" ? msg.media_group_id : null;
  const read = async () =>
    (await admin.from("bot_conversation_state").select("state, context, expires_at").eq("telegram_id", tgId).maybeSingle()).data;
  const st = await read();
  if (!st) return false;
  const live = !!st.expires_at && Date.parse(st.expires_at) > Date.now();

  // the other parts of an album whose first part is the answer
  if (st.state === TQ_ALBUM_STATE) {
    if (live && albumId && albumId === st.context?.media_group_id) {
      await deliverTqAlbumPart(admin, st.context, msg, deps);
      return true;
    }
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId).eq("state", TQ_ALBUM_STATE);
    return false;
  }
  if (st.state !== TQ_ANSWER_STATE) return false;
  const text = messageText(msg);
  const media = answerKind(msg);
  const isIntent = !media && (text.startsWith("/") || deps.isMenuButton(text));
  if (!live || isIntent) {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId).eq("state", TQ_ANSWER_STATE);
    return false;
  }
  if (!text && !media) {
    await deps.call("sendMessage", { chat_id: msg.chat.id, text: "Javobni matn, rasm, ovozli xabar yoki fayl qilib yuboring." });
    return true;
  }
  const questionId = Number(st.context?.question_id);
  // CLAIM: exactly one concurrent update (the parts of an album arrive as separate webhook calls) becomes the answer
  const claim = albumId
    ? await admin.from("bot_conversation_state")
      .update({ state: TQ_ALBUM_STATE, context: { question_id: questionId, media_group_id: albumId },
        updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + TQ_ALBUM_MS).toISOString() })
      .eq("telegram_id", tgId).eq("state", TQ_ANSWER_STATE).select("telegram_id")
    : await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId).eq("state", TQ_ANSWER_STATE).select("telegram_id");
  if (!Array.isArray(claim.data) || !claim.data.length) {
    // another part won the claim: if it is this album, this part goes under the answer
    const again = await read();
    if (albumId && again?.state === TQ_ALBUM_STATE && again.context?.media_group_id === albumId) {
      await deliverTqAlbumPart(admin, again.context, msg, deps);
    }
    return true;
  }
  await deliverTqAnswer(admin, questionId, viewer, msg, deps);
  return true;
}

/** Another part of the answer album: copied into the topic as a reply to the question (no second heading). */
async function deliverTqAlbumPart(admin: Db, ctx: any, msg: any, deps: SupportDeps) {
  const q = await loadQuestion(admin, Number(ctx?.question_id));
  if (!q) return;
  const r = await deps.call("copyMessage", {
    chat_id: q.chat_id, message_thread_id: q.thread_id, from_chat_id: msg.chat.id, message_id: msg.message_id,
    reply_parameters: { message_id: q.first_message_id, allow_sending_without_reply: true },
  });
  if (!r.ok) {
    await logHealth(admin, "teacher_question_answer_failed", { question_id: q.id, stage: "album_part", error: r.error },
      { source: "telegram-bot-webhook" });
  }
}

/** Post the teacher's message in the topic as a reply to the question, DM the student, mark it answered. */
export async function deliverTqAnswer(admin: Db, questionId: number, viewer: TqViewer, msg: any, deps: SupportDeps) {
  const chatId = Number(msg.chat.id);
  const q = await loadQuestion(admin, questionId);
  if (!q) {
    await deps.call("sendMessage", { chat_id: chatId, text: `⚠️ Savol #${questionId} topilmadi.` });
    return;
  }
  const groups = await viewerGroups(admin, viewer);
  if (!groups.some((g) => g.id === q.group_id)) {
    await deps.call("sendMessage", { chat_id: chatId, text: "⛔ Bu savol sizning guruhingizdan emas." });
    return;
  }
  const text = messageText(msg);
  const media = answerKind(msg);
  const reply = { message_id: q.first_message_id, allow_sending_without_reply: true };
  const caption = (extra: string) => `${tqAnswerHead()}${extra ? `\n\n${extra}` : ""}`;
  const cut = !media && text.length > TEXT_MAX - 40;

  // a sticker / video circle cannot carry a caption: the heading goes first, as its own reply
  if (media && NO_CAPTION.has(media)) {
    await deps.call("sendMessage", {
      chat_id: q.chat_id, message_thread_id: q.thread_id, parse_mode: "HTML", text: tqAnswerHead(), reply_parameters: reply,
    });
  }
  const posted = media
    ? await deps.call("copyMessage", {
      chat_id: q.chat_id, message_thread_id: q.thread_id, from_chat_id: chatId, message_id: msg.message_id,
      reply_parameters: reply,
      ...(NO_CAPTION.has(media) ? {} : { caption: caption(text ? escapeCapped(text, 900) : ""), parse_mode: "HTML" }),
    })
    : await deps.call("sendMessage", {
      chat_id: q.chat_id, message_thread_id: q.thread_id, parse_mode: "HTML", disable_web_page_preview: true,
      text: caption(escapeCapped(text, TEXT_MAX)), reply_parameters: reply,
    });
  const answerId = Number(posted.result?.message_id);
  if (!posted.ok || !Number.isSafeInteger(answerId)) {
    await logHealth(admin, "teacher_question_answer_failed", { question_id: q.id, teacher_id: viewer.id, media, error: posted.error },
      { source: "telegram-bot-webhook", targetUserId: viewer.id });
    await deps.call("sendMessage", {
      chat_id: chatId, parse_mode: "HTML",
      text: `⚠️ Javob guruhga yuborilmadi (${escapeCapped(String(posted.error ?? "xato"), 200)}). Savol ochiq qoldi — «✍️ Javob yozish»ni qayta bosing.`,
      reply_markup: { inline_keyboard: [[{ text: "✍️ Qayta yozish", callback_data: `tq:r:${q.id}` }]] },
    });
    return;
  }
  const { error: markErr } = await admin.from("teacher_questions")
    .update({ status: "answered", answered_at: new Date().toISOString(), answered_by: viewer.id, answered_via: "bot", answer_message_id: answerId })
    .eq("id", q.id).eq("status", "open");
  if (markErr) {
    // posted, but still open in the inbox: visible, and the teacher can close it with ✅
    await logHealth(admin, "teacher_question_answer_failed", { question_id: q.id, stage: "mark_answered", error: String(markErr.message ?? markErr) },
      { source: "telegram-bot-webhook", targetUserId: viewer.id });
  }

  // the student: only when the bot can write to them (they pressed Start)
  const link = messageLink(q.chat_id, q.thread_id, answerId);
  let dm = false;
  const { data: stu } = q.student_id
    ? await admin.from("profiles").select("telegram_id, telegram_write_access_at").eq("id", q.student_id).maybeSingle()
    : { data: null };
  if (stu?.telegram_id && stu.telegram_write_access_at) {
    const r = media && !NO_CAPTION.has(media)
      ? await deps.call("copyMessage", {
        chat_id: stu.telegram_id, from_chat_id: chatId, message_id: msg.message_id, parse_mode: "HTML",
        caption: tqStudentDm(q.text, text ? escapeCapped(text, 600) : "Kurator javobi", link),
      })
      : await deps.call("sendMessage", {
        chat_id: stu.telegram_id, parse_mode: "HTML", disable_web_page_preview: true,
        text: tqStudentDm(q.text, media ? "Kurator javobi — guruhda koʻring" : escapeCapped(text, 3000), link),
      });
    dm = r.ok;
    if (!r.ok) {
      await logHealth(admin, "teacher_question_student_dm_failed", { question_id: q.id, error: r.error },
        { source: "telegram-bot-webhook", targetUserId: q.student_id });
    }
  }
  await deps.call("sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `✅ Javob guruhga yuborildi (savol <b>#${q.id}</b>)` +
      (dm ? " va oʻquvchiga botda ham yetkazildi." : ". Oʻquvchiga bot orqali yuborib boʻlmadi — u guruhda koʻradi.") +
      (cut ? "\n\n<i>Javob juda uzun edi — oxiri qisqartirildi. Davomini yana «✍️ Yana javob yozish» bilan yuboring.</i>" : ""),
    reply_markup: { inline_keyboard: [[
      ...(link ? [{ text: "🔗 Guruhda koʻrish", url: link }] : []),
      { text: "❓ Keyingi savollar", callback_data: "tq:s" },
    ]] },
  });
}
