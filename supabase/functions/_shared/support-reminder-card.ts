// The hourly reminder for an unanswered «❓ Yordam» ticket (owner, 2026-10-07: "if I don't reply, resend it after an
// hour so that I don't lose it"). The WHOLE ticket again — who, the student's words, the screenshots copied under it —
// with the same buttons as the original card, so ✍️ / ✅ / a Reply on the reminder works exactly like on the original
// (the bot's sup: handler and its reply-to-card lookup in support_tickets.admin_messages).

import { escCap } from "./support-agent-card.ts";

/** The original card's buttons — parsed by telegram-bot-webhook/support.ts parseSupportCallback (sup:r / sup:d). */
export function ticketKeyboard(id: number) {
  return { inline_keyboard: [[{ text: "✍️ Javob yozish", callback_data: `sup:r:${id}` }, { text: "✅ Hal boʻldi", callback_data: `sup:d:${id}` }]] };
}

export type ReminderTicket = {
  id: number; display_name: string | null; username: string | null; group_name: string | null; locale: string | null;
  created_at: string; messages: unknown;
};

type Msg = { text: string; media: string | null; message_id: number | null };

export function ticketMessages(messages: unknown): Msg[] {
  const out: Msg[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const id = Number((m as any).message_id);
    out.push({
      text: String((m as any).text ?? "").trim(),
      media: (m as any).media ? String((m as any).media) : null,
      message_id: Number.isSafeInteger(id) && id > 0 ? id : null,
    });
  }
  return out;
}

const MEDIA_UZ: Record<string, string> = { photo: "skrinshot", video: "video", document: "fayl", voice: "ovozli xabar", video_note: "video xabar", audio: "audio" };

/** The reminder card (HTML). Every part is capped after escaping: < 3600 characters whatever the ticket holds. */
export function reminderCard(t: ReminderTicket, nowMs: number): string {
  const hours = Math.max(1, Math.floor((nowMs - new Date(t.created_at).getTime()) / 3_600_000));
  const msgs = ticketMessages(t.messages);
  const words = msgs.map((m) => m.text).filter(Boolean).join("\n— ");
  const media = msgs.filter((m) => m.media);
  const kinds = [...new Set(media.map((m) => MEDIA_UZ[m.media!] ?? m.media!))].join(", ");
  const who = `${escCap(t.display_name || "—", 120)}${t.username ? ` (@${escCap(t.username, 64)})` : ""}`;
  return [
    `🔔 <b>Eslatma: #${t.id} — ${hours} soatdan beri javobsiz</b>`,
    `👤 ${who}${t.group_name ? ` · ${escCap(t.group_name, 80)}` : ""} · ${escCap(t.locale || "uz", 4)}`,
    "",
    words ? escCap(words, 2500) : "<i>(matnsiz)</i>",
    ...(media.length ? [`📎 ${media.length} ta (${escCap(kinds, 80)}) — pastda`] : []),
    "",
    "↩️ Javob: «✍️ Javob yozish» yoki shu xabarga <b>reply</b> qiling.",
  ].join("\n");
}

const TASHKENT_OFFSET_H = 5;

/** Reminders wait out the night: no sends from quietStart (incl.) to quietEnd (excl.), Tashkent time. */
export function isQuietHour(nowMs: number, quietStart: number, quietEnd: number): boolean {
  const h = (new Date(nowMs).getUTCHours() + TASHKENT_OFFSET_H) % 24;
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd ? h >= quietStart && h < quietEnd : h >= quietStart || h < quietEnd;
}
