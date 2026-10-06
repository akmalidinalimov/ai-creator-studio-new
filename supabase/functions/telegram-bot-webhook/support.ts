// 🆘 «❓ Yordam» — technical support inside the bot (owner request, 2026-10-06).
//
// Before this, the button answered "Savollaringiz bo'lsa, biz bilan bog'laning:" with a link only when
// TELEGRAM_SUPPORT_HANDLE was set — it never was, so the tap did nothing useful.
//
// Flow (private chat):
//   student taps «❓ Yordam» (/yordam) → startSupport(): "describe the problem" + a ↩️ cancel button;
//     bot_conversation_state = 'awaiting_support' (30 min). With an OPEN ticket already, the next message is added
//     to it instead of opening a second one.
//   the student's next message (text, or a screenshot / file / voice, or an ALBUM) → captureSupport():
//     the state is CLAIMED atomically (one UPDATE … WHERE state='awaiting_support' RETURNING), so concurrent updates
//     — the parts of an album arrive as separate webhook calls — open exactly one ticket; the other parts of the
//     album find the claim (state 'support_open', same media_group_id) and are attached to that ticket.
//     A card goes to every admin with [✍️ Javob yozish] [✅ Hal boʻldi]; media is copied under the card. The student
//     is told "received" only when at least one admin got it — otherwise "saved, we'll get back to you" and a
//     support_ticket_undelivered row (the watchdog alerts within the hour).
//   admin answers — taps ✍️ (state 'awaiting_support_reply', the next message is the answer) or simply REPLIES to
//     the card / the copied screenshot → deliverReply(): the answer goes to the student with "✅ muammongiz hal
//     qilindi", the ticket becomes 'answered'. ✅ Hal boʻldi → the standard "solved" message, ONCE (claimed).
// A reply-keyboard button or a /command while a state is pending is never taken as a description or an answer:
// the state is dropped and the button works as usual (member forgiveness).
// Admins: _shared/admin-recipients.ts (two queries — profiles and user_roles share no FK, an embed returns nothing).
import { adminTelegramIds } from "../_shared/admin-recipients.ts";
import { logHealth } from "../_shared/edge.ts";

export type Locale = "uz" | "ru" | "en";
export const SUPPORT_STATE = "awaiting_support";
export const SUPPORT_OPEN_STATE = "support_open";          // claimed: the ticket of this message / album
export const SUPPORT_REPLY_STATE = "awaiting_support_reply";
export const SUPPORT_TTL_MS = 30 * 60_000;
export const SUPPORT_ALBUM_MS = 90_000;
export const SUPPORT_CANCEL = "sup:x";
const CARD_TEXT_MAX = 3200;      // escaped; the card adds < 500 more — under Telegram's 4096
const REPLY_TEXT_MAX = 3500;

type Db = any;
export type CallResult = { ok: boolean; result: any; error: string | null };
export type SupportDeps = {
  /** A Bot API call that records non-delivery (sendTelegramResult). */
  call: (method: string, payload: Record<string, unknown>) => Promise<CallResult>;
  /** A reply-keyboard button or a typed intent: never a description / an answer. */
  isMenuButton: (text: string) => boolean;
  /** Wait (album parts waiting for the first part's ticket). Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

const S: Record<Locale, {
  ask: string; askMore: (id: number) => string; cancel: string; cancelled: string; empty: string;
  received: (id: number) => string; added: (id: number) => string; savedNotSent: (id: number) => string; failed: string;
  replyHead: (id: number) => string; replyFoot: string; solved: (id: number) => string;
}> = {
  uz: {
    ask: "🛠 <b>Texnik muammoingizni yozing</b>\n\nNima ishlamayapti? Qisqacha va aniq yozing — kerak boʻlsa, <b>skrinshot</b> ham yuboring. " +
      "Xabaringiz adminga boradi, javobni shu yerda olasiz.",
    askMore: (id) => `🛠 Sizning <b>#${id}</b> murojaatingiz koʻrib chiqilmoqda.\n\nQoʻshimcha maʼlumot yoki skrinshot yuboring — u shu murojaatga qoʻshiladi.`,
    cancel: "↩️ Bekor qilish",
    cancelled: "↩️ Bekor qilindi.",
    empty: "✍️ Muammoni matn bilan yozing yoki skrinshot yuboring.",
    received: (id) => `✅ <b>Murojaatingiz qabul qilindi (#${id}).</b>\n\nAdmin koʻrib chiqib, javobni shu yerga yozadi. Kutib turing 🙏`,
    added: (id) => `✅ <b>#${id}</b> murojaatingizga qoʻshildi.`,
    savedNotSent: (id) => `📝 Murojaatingiz saqlandi (#${id}), lekin hozir adminga yetkazib boʻlmadi. Tez orada koʻrib chiqamiz — javob shu yerga keladi.`,
    failed: "⚠️ Hozir yuborib boʻlmadi. Birozdan keyin «❓ Yordam»ni qayta bosing.",
    replyHead: (id) => `💬 <b>Yordam xizmati javobi</b> (#${id})`,
    replyFoot: "✅ Muammongiz hal qilindi. Yana yordam kerak boʻlsa — «❓ Yordam» tugmasini bosing.",
    solved: (id) => `✅ <b>#${id}</b> murojaatingiz boʻyicha muammo hal qilindi.\n\nYana yordam kerak boʻlsa — «❓ Yordam» tugmasini bosing.`,
  },
  ru: {
    ask: "🛠 <b>Опишите техническую проблему</b>\n\nЧто не работает? Напишите коротко и понятно — при необходимости приложите <b>скриншот</b>. " +
      "Сообщение уйдёт администратору, ответ придёт сюда.",
    askMore: (id) => `🛠 Ваше обращение <b>#${id}</b> уже рассматривается.\n\nОтправьте дополнительную информацию или скриншот — они добавятся к этому обращению.`,
    cancel: "↩️ Отмена",
    cancelled: "↩️ Отменено.",
    empty: "✍️ Опишите проблему текстом или отправьте скриншот.",
    received: (id) => `✅ <b>Обращение принято (#${id}).</b>\n\nАдминистратор рассмотрит его и ответит здесь. Пожалуйста, подождите 🙏`,
    added: (id) => `✅ Добавлено к обращению <b>#${id}</b>.`,
    savedNotSent: (id) => `📝 Обращение сохранено (#${id}), но сейчас его не удалось передать администратору. Мы скоро его рассмотрим — ответ придёт сюда.`,
    failed: "⚠️ Сейчас не удалось отправить. Нажмите «❓ Помощь» ещё раз чуть позже.",
    replyHead: (id) => `💬 <b>Ответ службы поддержки</b> (#${id})`,
    replyFoot: "✅ Ваша проблема решена. Если снова понадобится помощь — нажмите «❓ Помощь».",
    solved: (id) => `✅ Проблема по обращению <b>#${id}</b> решена.\n\nЕсли снова понадобится помощь — нажмите «❓ Помощь».`,
  },
  en: {
    ask: "🛠 <b>Describe your technical problem</b>\n\nWhat isn't working? Keep it short and clear — add a <b>screenshot</b> if it helps. " +
      "Your message goes to an admin and the answer comes here.",
    askMore: (id) => `🛠 Your request <b>#${id}</b> is being looked at.\n\nSend more details or a screenshot — they will be added to it.`,
    cancel: "↩️ Cancel",
    cancelled: "↩️ Cancelled.",
    empty: "✍️ Describe the problem in text or send a screenshot.",
    received: (id) => `✅ <b>Request received (#${id}).</b>\n\nAn admin will look at it and answer here. Please wait 🙏`,
    added: (id) => `✅ Added to your request <b>#${id}</b>.`,
    savedNotSent: (id) => `📝 Your request is saved (#${id}), but it couldn't reach an admin right now. We'll look at it soon — the answer comes here.`,
    failed: "⚠️ Couldn't send right now. Tap «❓ Help» again in a moment.",
    replyHead: (id) => `💬 <b>Support reply</b> (#${id})`,
    replyFoot: "✅ Your problem is solved. If you need help again, tap «❓ Help».",
    solved: (id) => `✅ The problem in your request <b>#${id}</b> is solved.\n\nIf you need help again, tap «❓ Help».`,
  },
};

export function supportCopy(locale: Locale) {
  return S[locale] ?? S.uz;
}

function localeOf(v: unknown): Locale {
  return v === "ru" || v === "en" ? v : "uz";
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape, keeping the ESCAPED result within `max` characters (never cuts an entity in half); "…" when cut. */
export function escapeCapped(s: string, max: number): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const e = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
    if (out.length + e.length > max - 1) return out + "…";
    out += e;
  }
  return out;
}

/** sup:r:<id> | sup:d:<id> → the action and the ticket id; anything else → null. (<= 64 bytes by construction.) */
export function parseSupportCallback(data: string): { action: "reply" | "done"; id: number } | null {
  const m = /^sup:(r|d):(\d{1,12})$/.exec(String(data ?? ""));
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { action: m[1] === "r" ? "reply" : "done", id };
}

/** What kind of attachment a message carries (or null). */
export function mediaKind(msg: any): string | null {
  if (msg?.photo) return "photo";
  if (msg?.video) return "video";
  if (msg?.document) return "document";
  if (msg?.voice) return "voice";
  if (msg?.video_note) return "video_note";
  if (msg?.audio) return "audio";
  return null;
}

/** The text of a message (text or caption), trimmed. */
export function messageText(msg: any): string {
  const t = typeof msg?.text === "string" ? msg.text : typeof msg?.caption === "string" ? msg.caption : "";
  return t.trim();
}

/** The admin card for a ticket (HTML, < 4096). */
export function adminCard(t: {
  id: number; name: string; username: string | null; group: string | null; locale: string; text: string; media: string | null;
  followUp?: boolean;
}): string {
  const who = `${escapeCapped(t.name || "—", 120)}${t.username ? ` (@${escapeCapped(t.username, 64)})` : ""}`;
  const head = t.followUp ? `➕ <b>#${t.id} ga qoʻshimcha</b>` : `🆘 <b>Yordam soʻrovi #${t.id}</b>`;
  const body = t.text ? escapeCapped(t.text, CARD_TEXT_MAX) : "<i>(matnsiz)</i>";
  const media = t.media ? `\n📎 ${t.media === "photo" ? "skrinshot" : t.media} — pastda` : "";
  return `${head}\n👤 ${who}${t.group ? ` · ${escapeCapped(t.group, 80)}` : ""} · ${escapeHtml(t.locale)}\n\n${body}${media}\n\n` +
    "↩️ Javob: «✍️ Javob yozish» yoki shu xabarga <b>reply</b> qiling.";
}

export function adminKeyboard(id: number) {
  return { inline_keyboard: [[{ text: "✍️ Javob yozish", callback_data: `sup:r:${id}` }, { text: "✅ Hal boʻldi", callback_data: `sup:d:${id}` }]] };
}

function isoIn(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

async function readState(admin: Db, tgId: number): Promise<{ state: string; context: any; live: boolean } | null> {
  const { data: st } = await admin.from("bot_conversation_state")
    .select("state, expires_at, context").eq("telegram_id", tgId).maybeSingle();
  if (!st) return null;
  return { state: st.state, context: st.context ?? {}, live: !!st.expires_at && new Date(st.expires_at).getTime() > Date.now() };
}

async function clearState(admin: Db, tgId: number, state: string) {
  await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId).eq("state", state);
}

/** One UPDATE … WHERE state = <from> AND not expired RETURNING: exactly one concurrent caller wins. */
async function claimState(admin: Db, tgId: number, from: string, to: string, context: Record<string, unknown>, ttlMs: number) {
  const { data } = await admin.from("bot_conversation_state")
    .update({ state: to, context, updated_at: new Date().toISOString(), expires_at: isoIn(ttlMs) })
    .eq("telegram_id", tgId).eq("state", from).gt("expires_at", new Date().toISOString())
    .select("context");
  return Array.isArray(data) && data.length ? (data[0].context ?? {}) : null;
}

async function openTicketOf(admin: Db, profileId: string): Promise<number | null> {
  const { data } = await admin.from("support_tickets").select("id").eq("user_id", profileId).eq("status", "open")
    .order("id", { ascending: false }).limit(1);
  return Array.isArray(data) && data[0]?.id ? Number(data[0].id) : null;
}

/** Atomic jsonb appends (public.support_ticket_append): concurrent writers never lose an entry. */
async function appendTicket(admin: Db, id: number, messages: unknown[], adminMessages: unknown[]) {
  const { error } = await admin.rpc("support_ticket_append", { _id: id, _messages: messages, _admin_messages: adminMessages });
  if (error) {
    await logHealth(admin, "support_ticket_append_failed", { ticket_id: id, error: String(error.message ?? error).slice(0, 200) },
      { source: "telegram-bot-webhook" });
  }
}

/** «❓ Yordam»: ask for the description and wait for the next message. */
export async function startSupport(
  admin: Db, chatId: number, tgId: number, profileId: string, locale: Locale, deps: SupportDeps,
): Promise<void> {
  const c = supportCopy(locale);
  const open = await openTicketOf(admin, profileId).catch(() => null);
  await admin.from("bot_conversation_state").upsert({
    telegram_id: tgId, state: SUPPORT_STATE, context: { profile_id: profileId, ticket_id: open },
    updated_at: new Date().toISOString(), expires_at: isoIn(SUPPORT_TTL_MS),
  });
  await deps.call("sendMessage", {
    chat_id: chatId, text: open ? c.askMore(open) : c.ask, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: c.cancel, callback_data: SUPPORT_CANCEL }]] },
  });
}

/** The student's ↩️ cancel. */
export async function cancelSupport(admin: Db, chatId: number, tgId: number, locale: Locale, deps: SupportDeps) {
  await clearState(admin, tgId, SUPPORT_STATE);
  await deps.call("sendMessage", { chat_id: chatId, text: supportCopy(locale).cancelled, parse_mode: "HTML" });
}

export type Who = { id: string; name: string; username: string | null; groupId: string | null };

/** Copy a message to every admin chat that has this ticket's card, under the card. */
async function copyToAdmins(admin: Db, ticketId: number, fromChat: number, messageId: number, deps: SupportDeps) {
  const { data: t } = await admin.from("support_tickets").select("admin_messages").eq("id", ticketId).maybeSingle();
  const cards = new Map<number, number>();
  for (const m of ((t?.admin_messages as any[]) ?? [])) if (!cards.has(Number(m.chat))) cards.set(Number(m.chat), Number(m.msg));
  const copied: Array<{ chat: number; msg: number }> = [];
  for (const [chat, card] of cards) {
    const cp = await deps.call("copyMessage", { chat_id: chat, from_chat_id: fromChat, message_id: messageId, reply_to_message_id: card });
    if (cp.ok && cp.result?.message_id) copied.push({ chat, msg: Number(cp.result.message_id) });
  }
  return copied;
}

/**
 * A private message: a pending description (or a part of its album), a pending admin answer, or an admin's REPLY
 * to a ticket card. true = consumed (the caller stops); false = not ours.
 */
export async function captureSupport(
  admin: Db, msg: any, who: Who, isAdmin: boolean, locale: Locale, deps: SupportDeps,
): Promise<boolean> {
  const tgId = Number(msg?.from?.id);
  const chatId = Number(msg?.chat?.id);
  const text = messageText(msg);
  const media = mediaKind(msg);
  const albumId: string | null = typeof msg?.media_group_id === "string" ? msg.media_group_id : null;
  const isIntent = !media && (text.startsWith("/") || deps.isMenuButton(text));

  const st = await readState(admin, tgId);

  // 1. the student's description
  if (st?.state === SUPPORT_STATE || (st?.state === SUPPORT_OPEN_STATE && albumId)) {
    const c = supportCopy(locale);
    if (st.state === SUPPORT_STATE) {
      if (!st.live || (st.context.profile_id && st.context.profile_id !== who.id) || isIntent) {
        await clearState(admin, tgId, SUPPORT_STATE);
        return false;
      }
      if (!text && !media) {
        await deps.call("sendMessage", { chat_id: chatId, text: c.empty, parse_mode: "HTML" });
        return true;                                                            // the state stays
      }
    }
    const entry = { at: new Date().toISOString(), text: text.slice(0, 4000), media, message_id: msg.message_id ?? null };
    const claimed = await claimState(admin, tgId, SUPPORT_STATE, SUPPORT_OPEN_STATE,
      { ...st.context, profile_id: who.id, media_group_id: albumId, ticket_id: st.context.ticket_id ?? null, claiming: true },
      SUPPORT_ALBUM_MS);

    if (!claimed) {
      // Another update claimed it first — a sibling part of the same album: attach to that ticket.
      const sib = await readState(admin, tgId);
      if (!(sib?.state === SUPPORT_OPEN_STATE && sib.live && albumId && sib.context.media_group_id === albumId)) return false;
      let ticketId: number | null = sib.context.claiming ? null : Number(sib.context.ticket_id) || null;
      const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      for (let i = 0; i < 12 && !ticketId; i++) {                               // ≤ ~4 s for the first part's ticket
        await sleep(350);
        const again = await readState(admin, tgId);
        if (again?.state === SUPPORT_OPEN_STATE && !again.context.claiming) ticketId = Number(again.context.ticket_id) || null;
      }
      if (!ticketId) {
        await logHealth(admin, "support_album_part_lost", { profile_id: who.id, media_group_id: albumId },
          { source: "telegram-bot-webhook", targetUserId: who.id });
        return true;                                                            // never the homework hint for it
      }
      const copied = media && msg.message_id ? await copyToAdmins(admin, ticketId, chatId, msg.message_id, deps) : [];
      await appendTicket(admin, ticketId, [entry], copied);
      return true;
    }

    // We won the claim: create (or add to) the ticket, then tell the album siblings which ticket it is.
    let groupName: string | null = null;
    if (who.groupId) {
      try {
        const { data: g } = await admin.from("groups").select("name").eq("id", who.groupId).maybeSingle();
        groupName = g?.name ?? null;
      } catch (_e) { /* the card works without it */ }
    }
    let id: number | null = claimed.ticket_id ? Number(claimed.ticket_id) : null;
    let followUp = false;
    if (id) {
      const { data: t } = await admin.from("support_tickets").select("id, status").eq("id", id).maybeSingle();
      if (t && t.status === "open") {
        followUp = true;
        await appendTicket(admin, id, [entry], []);
      } else {
        id = null;
      }
    }
    if (!id) {
      const { data: ins, error } = await admin.from("support_tickets").insert({
        user_id: who.id, telegram_id: tgId, chat_id: chatId, username: who.username, display_name: who.name,
        group_name: groupName, locale, status: "open", messages: [entry],
      }).select("id").single();
      if (error || !ins?.id) {
        await clearState(admin, tgId, SUPPORT_OPEN_STATE);
        await logHealth(admin, "support_ticket_failed", { profile_id: who.id, error: error?.message ?? null },
          { source: "telegram-bot-webhook", targetUserId: who.id });
        await deps.call("sendMessage", { chat_id: chatId, text: c.failed, parse_mode: "HTML" });
        return true;
      }
      id = Number(ins.id);
    }
    await admin.from("bot_conversation_state").update({
      context: { profile_id: who.id, media_group_id: albumId, ticket_id: id, claiming: false }, updated_at: new Date().toISOString(),
    }).eq("telegram_id", tgId).eq("state", SUPPORT_OPEN_STATE);

    // to every admin: the card (+ the screenshot / file / voice, copied under it)
    const recipients = await adminTelegramIds(admin, { limit: 5 });
    if (recipients.error) {
      await logHealth(admin, "support_admins_lookup_failed", { ticket_id: id, error: recipients.error }, { source: "telegram-bot-webhook" });
    }
    const sentTo: Array<{ chat: number; msg: number }> = [];
    for (const adminChat of recipients.ids) {
      const r = await deps.call("sendMessage", {
        chat_id: adminChat, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: adminKeyboard(id),
        text: adminCard({ id, name: who.name, username: who.username, group: groupName, locale, text, media, followUp }),
      });
      if (r.ok && r.result?.message_id) {
        sentTo.push({ chat: adminChat, msg: Number(r.result.message_id) });
        if (media && msg.message_id) {
          const cp = await deps.call("copyMessage", {
            chat_id: adminChat, from_chat_id: chatId, message_id: msg.message_id, reply_to_message_id: r.result.message_id,
          });
          if (cp.ok && cp.result?.message_id) sentTo.push({ chat: adminChat, msg: Number(cp.result.message_id) });
        }
      }
    }
    if (sentTo.length) await appendTicket(admin, id, [], sentTo);
    else {
      await logHealth(admin, "support_ticket_undelivered", { ticket_id: id, profile_id: who.id, admins: recipients.ids.length },
        { source: "telegram-bot-webhook", targetUserId: who.id });
    }
    await deps.call("sendMessage", {
      chat_id: chatId, parse_mode: "HTML",
      text: !sentTo.length ? c.savedNotSent(id) : followUp ? c.added(id) : c.received(id),
    });
    return true;
  }

  if (!isAdmin) return false;

  // 2. the admin's answer after ✍️
  if (st?.state === SUPPORT_REPLY_STATE) {
    if (!st.live || isIntent) {
      await clearState(admin, tgId, SUPPORT_REPLY_STATE);
      return false;
    }
    if (!text && !media) return true;
    await clearState(admin, tgId, SUPPORT_REPLY_STATE);
    await deliverReply(admin, Number(st.context.ticket_id), who.id, chatId, msg, deps);
    return true;
  }

  // 3. the admin REPLIED to a ticket card / a copied screenshot
  const replyTo = Number(msg?.reply_to_message?.message_id ?? 0);
  if (replyTo && (text || media) && !isIntent) {
    const { data: hit } = await admin.from("support_tickets").select("id")
      .filter("admin_messages", "cs", JSON.stringify([{ chat: chatId, msg: replyTo }]))   // jsonb @> (not an array literal)
      .order("id", { ascending: false }).limit(1);
    const id = Array.isArray(hit) && hit[0]?.id ? Number(hit[0].id) : null;
    if (id) {
      await deliverReply(admin, id, who.id, chatId, msg, deps);
      return true;
    }
  }
  return false;
}

/** ✍️ Javob yozish: the admin's next message is the answer. */
export async function startAdminReply(admin: Db, chatId: number, tgId: number, ticketId: number, deps: SupportDeps) {
  const { data: t } = await admin.from("support_tickets").select("id, display_name, username, status").eq("id", ticketId).maybeSingle();
  if (!t) {
    await deps.call("sendMessage", { chat_id: chatId, text: `⚠️ #${ticketId} topilmadi.` });
    return;
  }
  const prev = await readState(admin, tgId);
  await admin.from("bot_conversation_state").upsert({
    telegram_id: tgId, state: SUPPORT_REPLY_STATE, context: { ticket_id: ticketId },
    updated_at: new Date().toISOString(), expires_at: isoIn(SUPPORT_TTL_MS),
  });
  const replaced = prev?.live && prev.state !== SUPPORT_REPLY_STATE ? `\n\n<i>(Oldin kutilayotgan amal — ${escapeHtml(prev.state)} — bekor qilindi.)</i>` : "";
  const answered = t.status === "answered" ? "\n<i>Bu murojaatga allaqachon javob berilgan — yana yozsangiz, qoʻshimcha javob sifatida boradi.</i>" : "";
  await deps.call("sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `✍️ <b>#${ticketId}</b> — ${escapeCapped(t.display_name ?? "—", 120)}${t.username ? ` (@${escapeCapped(t.username, 64)})` : ""} uchun javobingizni yozing ` +
      `(matn, skrinshot yoki ovozli xabar). U oʻquvchiga «muammo hal qilindi» bilan boradi.${answered}${replaced}`,
  });
}

/** Send the admin's message to the student as the answer, mark the ticket answered, confirm to the admin. */
export async function deliverReply(admin: Db, ticketId: number, adminId: string, adminChat: number, msg: any, deps: SupportDeps) {
  const { data: t } = await admin.from("support_tickets").select("id, chat_id, locale, username, display_name").eq("id", ticketId).maybeSingle();
  if (!t) {
    await deps.call("sendMessage", { chat_id: adminChat, text: `⚠️ #${ticketId} topilmadi.` });
    return;
  }
  const c = supportCopy(localeOf(t.locale));
  const text = messageText(msg);
  const media = mediaKind(msg);
  let ok = false;
  let err: string | null = null;
  if (media) {
    // a screenshot / voice answer: copied as is, then the header + footer as its own message
    const cp = await deps.call("copyMessage", { chat_id: t.chat_id, from_chat_id: adminChat, message_id: msg.message_id });
    ok = cp.ok; err = cp.error;
    if (ok) await deps.call("sendMessage", { chat_id: t.chat_id, parse_mode: "HTML", text: `${c.replyHead(ticketId)}\n\n${c.replyFoot}` });
  } else {
    const r = await deps.call("sendMessage", {
      chat_id: t.chat_id, parse_mode: "HTML", disable_web_page_preview: true,
      text: `${c.replyHead(ticketId)}\n\n${escapeCapped(text, REPLY_TEXT_MAX)}\n\n${c.replyFoot}`,
    });
    ok = r.ok; err = r.error;
  }
  const who = `${escapeCapped(t.display_name ?? "—", 120)}${t.username ? ` (@${escapeCapped(t.username, 64)})` : ""}`;
  if (ok) {
    await admin.from("support_tickets").update({
      status: "answered", answered_at: new Date().toISOString(), answered_by: adminId,
      reply_text: (text || (media ? `(${media})` : "")).slice(0, 4000) || null, updated_at: new Date().toISOString(),
    }).eq("id", ticketId);
    const cut = !media && escapeHtml(text).length > REPLY_TEXT_MAX ? " (uzun boʻlgani uchun qisqartirildi)" : "";
    await deps.call("sendMessage", { chat_id: adminChat, parse_mode: "HTML", text: `✅ Javob yuborildi: <b>#${ticketId}</b> → ${who}${cut}` });
  } else {
    await logHealth(admin, "support_reply_undelivered", { ticket_id: ticketId, error: err }, { source: "telegram-bot-webhook" });
    await deps.call("sendMessage", {
      chat_id: adminChat, parse_mode: "HTML",
      text: `⚠️ <b>#${ticketId}</b> javobi ${who} ga yetib bormadi${err ? `: ${escapeCapped(err, 200)}` : ""}. (Botni bloklagan boʻlishi mumkin.)`,
    });
  }
}

/** ✅ Hal boʻldi: the standard "solved" message, once — the ticket is claimed (open → answered) first. */
export async function markSolved(admin: Db, ticketId: number, adminId: string, adminChat: number, deps: SupportDeps) {
  const { data: claimed } = await admin.from("support_tickets").update({
    status: "answered", answered_at: new Date().toISOString(), answered_by: adminId,
    reply_text: "(hal boʻldi)", updated_at: new Date().toISOString(),
  }).eq("id", ticketId).eq("status", "open").select("id, chat_id, locale, username, display_name");
  const t = Array.isArray(claimed) ? claimed[0] : null;
  if (!t) {
    await deps.call("sendMessage", { chat_id: adminChat, parse_mode: "HTML", text: `ℹ️ <b>#${ticketId}</b> allaqachon yopilgan yoki topilmadi.` });
    return;
  }
  const c = supportCopy(localeOf(t.locale));
  const who = `${escapeCapped(t.display_name ?? "—", 120)}${t.username ? ` (@${escapeCapped(t.username, 64)})` : ""}`;
  const r = await deps.call("sendMessage", { chat_id: t.chat_id, parse_mode: "HTML", text: c.solved(ticketId) });
  if (r.ok) {
    await deps.call("sendMessage", { chat_id: adminChat, parse_mode: "HTML", text: `✅ <b>#${ticketId}</b> yopildi → ${who}` });
  } else {
    // not delivered: reopen so the watchdog keeps it visible
    await admin.from("support_tickets").update({ status: "open", answered_at: null, answered_by: null, reply_text: null })
      .eq("id", ticketId);
    await logHealth(admin, "support_reply_undelivered", { ticket_id: ticketId, error: r.error }, { source: "telegram-bot-webhook" });
    await deps.call("sendMessage", { chat_id: adminChat, parse_mode: "HTML", text: `⚠️ <b>#${ticketId}</b>: ${who} ga yetib bormadi.` });
  }
}
