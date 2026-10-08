// 🆘 The admins' support inbox in the bot — the button / command and its sup:i · sup:l · sup:o callbacks
// (the pure parts are in _shared/support-inbox.ts). The caller (index.ts) has already checked: the REAL clicker is an
// admin, not impersonating.

import { logHealth } from "../_shared/edge.ts";
import {
  bucketize, fetchOpenTickets, type InboxCallback, newHoursOf, renderInboxSummary, renderTicketList,
} from "../_shared/support-inbox.ts";
import { reminderCard, ticketKeyboard, ticketMessages, type ReminderTicket } from "../_shared/support-reminder-card.ts";
import type { SupportDeps } from "./support.ts";

type Db = any;

async function settings(admin: Db): Promise<number> {
  const { data } = await admin.from("platform_settings").select("value").eq("key", "support_reminders").maybeSingle();
  return newHoursOf(data?.value);
}

/** Edit the tapped message in place when there is one (list navigation), else send a new message. */
async function show(deps: SupportDeps, chatId: number, messageId: number | null, r: { text: string; keyboard: unknown }) {
  if (messageId) {
    const e = await deps.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: r.keyboard,
    });
    if (e.ok || /not modified/i.test(e.error ?? "")) return;
  }
  await deps.call("sendMessage", { chat_id: chatId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: r.keyboard });
}

/** The summary (the 🆘 Murojaatlar button, /murojaatlar, the 🔄 / 🔙 buttons). */
export async function sendInboxSummary(admin: Db, chatId: number, deps: SupportDeps, messageId: number | null = null) {
  try {
    const now = Date.now();
    const newHours = await settings(admin);
    const b = bucketize(await fetchOpenTickets(admin), now, newHours);
    await show(deps, chatId, messageId, renderInboxSummary(b, now, newHours));
  } catch (e) {
    await logHealth(admin, "support_inbox_failed", { error: String((e as any)?.message ?? e).slice(0, 200) }, { source: "telegram-bot-webhook" });
    await deps.call("sendMessage", { chat_id: chatId, text: "⚠️ Murojaatlarni hozir ochib boʻlmadi. Birozdan keyin qayta urinib koʻring." });
  }
}

export async function handleInboxCallback(admin: Db, cb: InboxCallback, chatId: number, messageId: number | null, deps: SupportDeps) {
  if (cb.kind === "summary") return sendInboxSummary(admin, chatId, deps, messageId);
  try {
    const now = Date.now();
    if (cb.kind === "list") {
      const newHours = await settings(admin);
      const b = bucketize(await fetchOpenTickets(admin), now, newHours);
      return show(deps, chatId, messageId, renderTicketList(cb.bucket, cb.bucket === "n" ? b.fresh : b.old, cb.page, now));
    }
    // open: the full card + the screenshots copied under it; recorded so a Reply on them answers the ticket
    const { data: t } = await admin.from("support_tickets")
      .select("id, created_at, display_name, username, group_name, locale, messages, chat_id, status").eq("id", cb.id).maybeSingle();
    if (!t) {
      await deps.call("sendMessage", { chat_id: chatId, text: `⚠️ #${cb.id} topilmadi.` });
      return;
    }
    const done = t.status !== "open";
    const heading = `📂 <b>Murojaat #${t.id}</b>${done ? " — ✅ javob berilgan" : ""}`;
    const card = await deps.call("sendMessage", {
      chat_id: chatId, parse_mode: "HTML", disable_web_page_preview: true,
      text: reminderCard(t as ReminderTicket, now, heading), reply_markup: ticketKeyboard(t.id),
    });
    const cardId = Number(card.result?.message_id);
    if (!card.ok || !Number.isSafeInteger(cardId)) {
      await logHealth(admin, "support_inbox_open_failed", { ticket_id: t.id, error: card.error }, { source: "telegram-bot-webhook" });
      await deps.call("sendMessage", { chat_id: chatId, text: `⚠️ #${t.id} ni ochib boʻlmadi. Birozdan keyin qayta urinib koʻring.` });
      return;
    }
    const sent: Array<{ chat: number; msg: number }> = [{ chat: chatId, msg: cardId }];
    const media = ticketMessages(t.messages).filter((x) => x.media && x.message_id).slice(0, 10);
    let copyFailed = 0;
    for (const m of media) {
      const cp = await deps.call("copyMessage", {
        chat_id: chatId, from_chat_id: t.chat_id, message_id: m.message_id,
        reply_parameters: { message_id: cardId, allow_sending_without_reply: true },
      });
      const id = Number(cp.result?.message_id);
      if (cp.ok && Number.isSafeInteger(id)) sent.push({ chat: chatId, msg: id });
      else copyFailed++;
    }
    if (copyFailed) {
      // e.g. the student deleted the message: say so under the card, and make it visible
      await logHealth(admin, "support_inbox_copy_failed", { ticket_id: t.id, failed: copyFailed, total: media.length },
        { source: "telegram-bot-webhook" });
      await deps.call("sendMessage", {
        chat_id: chatId, text: `📎 ${copyFailed} ta fayl koʻchirilmadi (oʻquvchi oʻchirgan boʻlishi mumkin).`,
        reply_parameters: { message_id: cardId, allow_sending_without_reply: true },
      });
    }
    const { error } = await admin.rpc("support_ticket_append", { _id: t.id, _messages: [], _admin_messages: sent });
    if (error) {
      await logHealth(admin, "support_ticket_append_failed", { ticket_id: t.id, error: String(error.message ?? error).slice(0, 200), via: "inbox" },
        { source: "telegram-bot-webhook" });
    }
  } catch (e) {
    await logHealth(admin, "support_inbox_failed", { error: String((e as any)?.message ?? e).slice(0, 200), cb: cb.kind }, { source: "telegram-bot-webhook" });
    await deps.call("sendMessage", { chat_id: chatId, text: "⚠️ Murojaatlarni hozir ochib boʻlmadi. Birozdan keyin qayta urinib koʻring." });
  }
}
