// The admins' support inbox in the bot (owner, 2026-10-08: "a Telegram button for the tickets, filter the NEW ones
// and the OLDER ones that are still open — structured, so I first see the new ones, then the older open ones").
//
//   🆘 Murojaatlar (admin keyboard / /murojaatlar)  →  summary: 🆕 new (< new_hours) · ⏳ older open
//   [🆕 Yangilar (n)] [⏳ Eskilar (m)]  →  a compact list, 8 per page (new: newest first; older: most overdue first)
//   [#12 · Robiya · 3 soat]  →  the full ticket card + its screenshots, with ✍️ / ✅ (a Reply on it answers the ticket)
//
// Callback data (≤ 64 bytes): sup:i (summary) · sup:l:<n|o>:<page> (a list) · sup:o:<ticket> (open one).
// The bot handles them (telegram-bot-webhook/support-inbox-bot.ts); the 5-hour digest (support-reminder) sends the
// same summary. Pure except fetchOpenTickets.

import { escCap } from "./support-agent-card.ts";
import { ticketMessages } from "./support-reminder-card.ts";

type Db = any;
type Kb = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

export const DEFAULT_NEW_HOURS = 6;
export const PAGE_SIZE = 8;

export type InboxTicket = {
  id: number; created_at: string; display_name: string | null; username: string | null; group_name: string | null;
  locale: string | null; messages: unknown; admin_messages: unknown; chat_id: number; status?: string;
};

export type InboxCallback =
  | { kind: "summary" }
  | { kind: "list"; bucket: "n" | "o"; page: number }
  | { kind: "open"; id: number };

export function parseInboxCallback(data: string): InboxCallback | null {
  const d = String(data ?? "");
  if (d === "sup:i") return { kind: "summary" };
  let m = /^sup:l:([no]):(\d{1,4})$/.exec(d);
  if (m) return { kind: "list", bucket: m[1] as "n" | "o", page: Number(m[2]) };
  m = /^sup:o:(\d{1,12})$/.exec(d);
  if (m) {
    const id = Number(m[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: "open", id } : null;
  }
  return null;
}

/** "15 daq" · "3 soat" · "2 kun" */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${Math.max(1, min)} daq`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} soat`;
  return `${Math.floor(h / 24)} kun`;
}

export function newHoursOf(settings: unknown): number {
  const n = Number((settings as Record<string, unknown> | null)?.new_hours);
  return Number.isInteger(n) && n >= 1 && n <= 72 ? n : DEFAULT_NEW_HOURS;
}

/** New = opened less than `newHours` ago (newest first); older = the rest (the longest-waiting first). */
export function bucketize(rows: InboxTicket[], nowMs: number, newHours: number) {
  const cut = nowMs - newHours * 3_600_000;
  const fresh = rows.filter((r) => Date.parse(r.created_at) >= cut).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const old = rows.filter((r) => Date.parse(r.created_at) < cut).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return { fresh, old };
}

export async function fetchOpenTickets(admin: Db): Promise<InboxTicket[]> {
  const { data, error } = await admin.from("support_tickets")
    .select("id, created_at, display_name, username, group_name, locale, messages, admin_messages, chat_id, status")
    .eq("status", "open").order("created_at", { ascending: true }).limit(200);
  if (error) throw new Error(`support_tickets: ${String(error.message ?? error).slice(0, 200)}`);
  return (data ?? []) as InboxTicket[];
}

/** The summary: counts per bucket + the oldest wait, with the two list buttons (HTML). */
export function renderInboxSummary(
  b: { fresh: InboxTicket[]; old: InboxTicket[] }, nowMs: number, newHours: number, heading = "🆘 <b>Murojaatlar</b>",
): { text: string; keyboard: Kb } {
  const total = b.fresh.length + b.old.length;
  const oldest = b.old[0] ?? b.fresh[b.fresh.length - 1];
  const lines = [
    `${heading} — ${total ? `${total} ta ochiq` : "ochiq murojaat yoʻq ✅"}`,
  ];
  if (total) {
    lines.push(`🆕 Yangi (${newHours} soatgacha): <b>${b.fresh.length}</b>`);
    lines.push(`⏳ Eskiroq ochiq: <b>${b.old.length}</b>${oldest ? ` · eng eskisi ${ageText(nowMs - Date.parse(oldest.created_at))}` : ""}`);
    lines.push("", "Roʻyxatni ochish uchun tugmani bosing.");
  }
  const row: Array<{ text: string; callback_data: string }> = [];
  if (b.fresh.length) row.push({ text: `🆕 Yangilar (${b.fresh.length})`, callback_data: "sup:l:n:0" });
  if (b.old.length) row.push({ text: `⏳ Eskilar (${b.old.length})`, callback_data: "sup:l:o:0" });
  const keyboard: Kb = { inline_keyboard: [] };
  if (row.length) keyboard.inline_keyboard.push(row);
  keyboard.inline_keyboard.push([{ text: "🔄 Yangilash", callback_data: "sup:i" }]);
  return { text: lines.join("\n"), keyboard };
}

function snippet(t: InboxTicket): string {
  const msgs = ticketMessages(t.messages);
  const words = msgs.map((m) => m.text).find(Boolean) ?? "";
  const media = msgs.filter((m) => m.media).length;
  return `${words ? `«${escCap(words, 60)}»` : "<i>(matnsiz)</i>"}${media ? ` 📎${media}` : ""}`;
}

/** One page of a bucket: a line per ticket + an "open" button per ticket, ◀️ ▶️ and back to the summary. */
export function renderTicketList(
  bucket: "n" | "o", rows: InboxTicket[], page: number, nowMs: number,
): { text: string; keyboard: Kb } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const title = bucket === "n" ? "🆕 <b>Yangi murojaatlar</b>" : "⏳ <b>Eskiroq ochiq murojaatlar</b> (eng uzoq kutayotgani birinchi)";
  const lines = [`${title} — ${rows.length} ta${pages > 1 ? ` · ${p + 1}/${pages}-sahifa` : ""}`, ""];
  const kb: Kb = { inline_keyboard: [] };
  if (!slice.length) lines.push("Bu roʻyxat boʻsh ✅");
  for (const t of slice) {
    const who = `${escCap(t.display_name || "—", 40)}${t.username ? ` (@${escCap(t.username, 32)})` : ""}`;
    lines.push(`<b>#${t.id}</b> · ${who}${t.group_name ? ` · ${escCap(t.group_name, 30)}` : ""} · ${ageText(nowMs - Date.parse(t.created_at))}`);
    lines.push(`   ${snippet(t)}`);
    const short = (t.display_name || t.username || "—").slice(0, 18);
    kb.inline_keyboard.push([{ text: `📂 #${t.id} · ${short} · ${ageText(nowMs - Date.parse(t.created_at))}`, callback_data: `sup:o:${t.id}` }]);
  }
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (p > 0) nav.push({ text: "◀️", callback_data: `sup:l:${bucket}:${p - 1}` });
  nav.push({ text: "🔙 Umumiy", callback_data: "sup:i" });
  if (p < pages - 1) nav.push({ text: "▶️", callback_data: `sup:l:${bucket}:${p + 1}` });
  kb.inline_keyboard.push(nav);
  return { text: lines.join("\n"), keyboard: kb };
}
