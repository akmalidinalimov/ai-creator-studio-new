// 🤖 The support auto-resolver's buttons (sa:) under a proposal card the support-agent worker sent to the admins.
//
//   ✅ Tasdiqlash va bajarish (sa:a) → a data change asks once more (sa:c ✅ Ha / sa:n ↩️ Yoʻq); a reply-only one sends.
//   ❌ Rad etish (sa:r)               → nothing runs, nothing is sent.
//
// support_apply_fix() is the ONLY write path: it re-checks the kill-switch, the admin, the TTL, re-diagnoses on fresh
// data (a changed situation → 'superseded', nothing runs), executes the whitelisted action AS the admin, and verifies
// it. This module only delivers the approved reply to the student — only for a verified fix or an approved reply, and
// only once: delivery is CLAIMED in SQL (support_proposal_claim_delivery) and recorded after the send
// (support_proposal_delivered, which also marks the ticket answered). A crash between the fix and the send leaves the
// proposal undelivered — the watchdog counts it, and the next tap on the still-live card delivers it.
//
// The caller (index.ts) has already checked: the REAL clicker (not an impersonated persona) is an admin.

import { logHealth } from "../_shared/edge.ts";
import { confirmKeyboard, parseSaCallback, proposalKeyboard } from "../_shared/support-agent-card.ts";
import { escapeCapped, escapeHtml, type Locale, type SupportDeps, supportCopy } from "./support.ts";

type Db = any;
const REPLY_MAX = 3000;

function localeOf(v: unknown): Locale {
  return v === "ru" || v === "en" ? v : "uz";
}

function whoOf(t: { display_name?: string | null; username?: string | null }): string {
  return `${escapeCapped(t.display_name ?? "—", 120)}${t.username ? ` (@${escapeCapped(t.username, 64)})` : ""}`;
}

const STATUS_UZ: Record<string, string> = {
  verified: "bajarilgan", sent: "javob yuborilgan", verify_failed: "tekshiruvdan oʻtmagan", applied: "bajarilgan",
  rejected: "rad etilgan", superseded: "eskirgan", expired: "muddati oʻtgan", failed: "bajarilmagan", not_open: "yopilgan",
  shadow: "sinov rejimida",
};
const statusUz = (s: unknown) => STATUS_UZ[String(s)] ?? "yopilgan";

/** The admin-facing line for an apply/decide outcome (HTML). Never shows a raw internal code. */
export function outcomeLine(ticketId: number, res: Record<string, any>, who: string, delivered: boolean | null): string {
  const t = `<b>#${ticketId}</b>`;
  if (res.already && delivered === null) return `ℹ️ ${t}: bu taklif allaqachon koʻrib chiqilgan (${statusUz(res.status)}).`;
  if (!res.ok && !res.already) {
    switch (res.reason) {
      case "disabled": return `⏸ Yordam agenti oʻchirilgan — hech narsa bajarilmadi.`;
      case "superseded": return `♻️ ${t}: holat oʻzgargan, taklif eskirdi — hech narsa oʻzgarmadi. Kerak boʻlsa, «✏️ Oʻzim yozaman».`;
      case "ticket_closed": return `ℹ️ ${t}: murojaatga allaqachon javob berilgan — taklif yopildi, hech narsa oʻzgarmadi.`;
      case "expired": return `⌛ ${t}: taklif muddati oʻtgan — hech narsa oʻzgarmadi.`;
      case "failed": return `❌ ${t}: bajarilmadi — ${escapeCapped(String(res.error ?? ""), 200)}. Hech narsa oʻzgarmadi.`;
      case "not_admin": return `⛔`;
      case "not_found": return `⚠️ Taklif topilmadi.`;
      default: return `ℹ️ ${t}: bu taklif allaqachon ${statusUz(res.reason)}.`;
    }
  }
  if (res.status === "rejected") return `❌ ${t}: rad etildi — hech narsa oʻzgarmadi.`;
  if (res.status === "verify_failed") {
    return `⚠️ ${t}: amal bajarildi, lekin tekshiruvdan oʻtmadi — oʻquvchiga javob YUBORILMADI. Qoʻlda tekshiring.`;
  }
  const done = res.status === "verified" ? "bajarildi · tekshirildi · " : "";
  if (delivered === false) return `⚠️ ${t}: ${done}lekin javob ${who} ga yetib bormadi (botni bloklagan boʻlishi mumkin).`;
  return `✅ ${t}: ${done}javob yuborildi → ${who}`;
}

async function loadProposal(admin: Db, id: number) {
  const { data } = await admin.from("support_fix_proposals")
    .select("id, ticket_id, action, class, status, student_message, admin_messages").eq("id", id).maybeSingle();
  return data as null | {
    id: number; ticket_id: number; action: string | null; class: string; status: string; student_message: string | null;
    admin_messages: { chat: number; msg: number }[] | null;
  };
}

/** Every admin's copy of the card: buttons off, then one result line under it. */
async function closeCards(p: { admin_messages: { chat: number; msg: number }[] | null }, line: string, deps: SupportDeps) {
  for (const m of Array.isArray(p.admin_messages) ? p.admin_messages : []) {
    await deps.call("editMessageReplyMarkup", { chat_id: m.chat, message_id: m.msg, reply_markup: { inline_keyboard: [] } });
    await deps.call("sendMessage", {
      chat_id: m.chat, parse_mode: "HTML", text: line,
      reply_parameters: { message_id: m.msg, allow_sending_without_reply: true },
    });
  }
}

/**
 * The approved reply to the student, at most once: claimed in SQL first (ok:null = someone else has it, or it's done),
 * the outcome recorded after (support_proposal_delivered marks the ticket answered — except a code-bug "we're looking
 * into it", which keeps it open and carries no "solved" footer).
 */
async function deliver(
  admin: Db, p: { id: number; ticket_id: number; class: string; student_message: string | null }, adminId: string, deps: SupportDeps,
): Promise<{ ok: boolean | null; who: string; error: string | null }> {
  const { data: claimed, error: ce } = await admin.rpc("support_proposal_claim_delivery", { _id: p.id });
  if (ce || claimed !== true) return { ok: null, who: "", error: ce ? String(ce.message ?? ce) : null };
  const { data: t } = await admin.from("support_tickets").select("id, chat_id, locale, username, display_name").eq("id", p.ticket_id).maybeSingle();
  let r: { ok: boolean; error: string | null } = { ok: false, error: "ticket_not_found" };
  const c = supportCopy(localeOf(t?.locale));
  const keepOpen = p.class === "code_bug";
  if (t) {
    r = await deps.call("sendMessage", {
      chat_id: t.chat_id, parse_mode: "HTML", disable_web_page_preview: true,
      text: `${c.replyHead(p.ticket_id)}\n\n${escapeCapped(p.student_message ?? "", REPLY_MAX)}${keepOpen ? "" : `\n\n${c.replyFoot}`}`,
    });
  }
  // recorded, with one retry: a sent-but-unrecorded reply could be sent again by a later tap once the claim goes stale
  const rec = { _id: p.id, _ok: r.ok, _error: r.error, _admin: adminId };
  let { error: de } = await admin.rpc("support_proposal_delivered", rec);
  if (de) ({ error: de } = await admin.rpc("support_proposal_delivered", rec));
  if (de) {
    await logHealth(admin, "support_delivery_record_failed", { proposal_id: p.id, error: String(de.message ?? de).slice(0, 200) },
      { source: "telegram-bot-webhook" });
  }
  if (!r.ok) {
    await logHealth(admin, "support_reply_undelivered", { ticket_id: p.ticket_id, error: r.error, via: "support_agent" },
      { source: "telegram-bot-webhook" });
  }
  return { ok: r.ok, who: t ? whoOf(t) : "—", error: r.error };
}

async function apply(admin: Db, id: number, adminId: string, chatId: number, deps: SupportDeps) {
  const { data, error } = await admin.rpc("support_apply_fix", { _proposal: id, _admin: adminId });
  const res = (error ? { ok: false, reason: "failed", error: String(error.message ?? error) } : data ?? {}) as Record<string, any>;
  if (error) await logHealth(admin, "support_apply_rpc_failed", { proposal_id: id, error: String(error.message ?? error).slice(0, 300) },
    { source: "telegram-bot-webhook" });
  const p = await loadProposal(admin, id);
  const ticketId = Number(res.ticket_id ?? p?.ticket_id ?? 0);
  if (!p || (!res.ok && !res.already)) {
    const line = outcomeLine(ticketId, res, "", null);
    // THIS tap ended the proposal (superseded / ticket answered by hand / expired / the action failed) → every copy
    // closes. Anything else (disabled, an RPC error) only answers the clicker.
    const endedHere = !error && ["superseded", "ticket_closed", "expired", "failed"].includes(String(res.reason));
    if (p && endedHere) await closeCards(p, line, deps);
    else await deps.call("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: line });
    return;
  }
  // the first tap — or a later tap on a fix whose reply never went out (a crash between the fix and the send): the
  // SQL claim makes sure only one tap ever sends
  let delivered: boolean | null = null;
  let who = "";
  if (res.status === "verified" || res.status === "sent") {
    const d = await deliver(admin, p, adminId, deps);
    delivered = d.ok; who = d.who;
  }
  if (res.already && delivered === null) {
    await deps.call("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: outcomeLine(ticketId, res, "", null) });
    return;
  }
  await closeCards(p, outcomeLine(ticketId, res, who, delivered), deps);
}

/** sa:<a|c|n|r>:<id>. Returns false when `data` isn't an sa: callback this module understands. */
export async function handleSupportAgentCallback(
  admin: Db, data: string, adminId: string, chatId: number, messageId: number | null, deps: SupportDeps,
): Promise<boolean> {
  const sc = parseSaCallback(data);
  if (!sc) return false;
  const p = await loadProposal(admin, sc.id);
  if (!p) {
    await deps.call("sendMessage", { chat_id: chatId, text: "⚠️ Taklif topilmadi." });
    return true;
  }
  if (sc.action === "reject") {
    const { data: res, error } = await admin.rpc("support_proposal_decide", { _id: sc.id, _admin: adminId, _decision: "rejected" });
    const r = (error ? { ok: false, reason: "failed", error: String(error.message ?? error) } : res ?? {}) as Record<string, any>;
    if (r.ok) await closeCards(p, outcomeLine(p.ticket_id, r, "", null), deps);
    else {
      await deps.call("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: outcomeLine(p.ticket_id, r, "", null) });
      // closed by someone else meanwhile: this copy's buttons are stale
      if (r.reason === "not_open" && messageId) {
        await deps.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      }
    }
    return true;
  }
  // a closed proposal — except an approved fix/reply whose student message may still be owed (apply() re-delivers it)
  const owed = (p.status === "verified" || p.status === "sent") && (sc.action === "approve" || sc.action === "confirm");
  if (p.status !== "proposed" && !owed) {
    await deps.call("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: outcomeLine(p.ticket_id, { ok: false, reason: p.status }, "", null) });
    if (messageId) await deps.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return true;
  }
  if (sc.action === "back") {
    if (messageId) {
      await deps.call("editMessageReplyMarkup", {
        chat_id: chatId, message_id: messageId,
        reply_markup: proposalKeyboard({ id: p.id, ticketId: p.ticket_id, action: p.action, hasReply: !!p.student_message }),
      });
    }
    return true;
  }
  if (sc.action === "approve" && p.action && !owed) {
    // a data change: one more tap, on this admin's copy only
    if (messageId) await deps.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: confirmKeyboard(p.id) });
    else await apply(admin, p.id, adminId, chatId, deps);
    return true;
  }
  await apply(admin, p.id, adminId, chatId, deps);
  return true;
}
