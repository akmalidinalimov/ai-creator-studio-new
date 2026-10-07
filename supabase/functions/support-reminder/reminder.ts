// support-reminder — every unanswered «❓ Yordam» ticket is re-sent to the admins every hour (default) until it is
// answered or closed: the reminder card + the student's screenshots / files / voice copied under it, same buttons.
// Each reminder's message ids are appended to support_tickets.admin_messages, so replying to a REMINDER answers the
// ticket exactly like replying to the original card.
//
// Settings: platform_settings.support_reminders = {enabled, every_min, quiet_start_hour, quiet_end_hour} (Tashkent).
// A ticket is CLAIMED (reminded_at stamped atomically) before it is sent: two overlapping runs never double-send.
// Backstop: support_tickets_watchdog (SQL, :27) still DMs a list of tickets older than 3 h that nobody reminded in 12 h
// — independent of this function, so a dead reminder function is still caught.
//
// Pure except for the injected I/O (reminder.test.ts runs it with fakes). index.ts is the HTTP shell.

import { logHealth } from "../_shared/edge.ts";
import { adminTelegramIds } from "../_shared/admin-recipients.ts";
import { isQuietHour, reminderCard, ticketKeyboard, ticketMessages, type ReminderTicket } from "../_shared/support-reminder-card.ts";

type Db = any;
export type SendFn = (method: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result: any; error: string | null }>;
export interface Io { admin: Db; send: SendFn; now: () => number }

export const DEFAULTS = { enabled: true, every_min: 60, quiet_start_hour: 23, quiet_end_hour: 8 };
const BATCH = 10;          // tickets per run
const MAX_COPIES = 10;     // media copied under one reminder

export type Settings = typeof DEFAULTS;

export function settingsOf(v: unknown): Settings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const int = (x: unknown, d: number, lo: number, hi: number) => {
    const n = Number(x);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    enabled: o.enabled === undefined ? DEFAULTS.enabled : o.enabled === true,
    every_min: int(o.every_min, DEFAULTS.every_min, 15, 24 * 60),
    quiet_start_hour: int(o.quiet_start_hour, DEFAULTS.quiet_start_hour, 0, 23),
    quiet_end_hour: int(o.quiet_end_hour, DEFAULTS.quiet_end_hour, 0, 23),
  };
}

export async function runOnce(io: Io): Promise<{ status: string; [k: string]: unknown }> {
  const { admin } = io;
  const now = io.now();
  const { data: row } = await admin.from("platform_settings").select("value").eq("key", "support_reminders").maybeSingle();
  const cfg = settingsOf(row?.value);
  if (!cfg.enabled) return { status: "disabled" };
  if (isQuietHour(now, cfg.quiet_start_hour, cfg.quiet_end_hour)) return { status: "quiet_hours" };

  const cutoff = new Date(now - cfg.every_min * 60_000).toISOString();
  const { data: due, error } = await admin.from("support_tickets")
    .select("id, chat_id, display_name, username, group_name, locale, created_at, messages")
    .eq("status", "open").lt("created_at", cutoff)
    .or(`reminded_at.is.null,reminded_at.lt.${cutoff}`)
    .order("id", { ascending: true }).limit(BATCH);
  if (error) throw new Error(`support_tickets: ${String(error.message ?? error).slice(0, 200)}`);
  if (!due?.length) return { status: "idle" };

  const admins = await adminTelegramIds(admin);
  if (!admins.ids.length) {
    await logHealth(admin, "support_reminder_no_admins", { error: admins.error, due: due.length }, { source: "support-reminder" });
    return { status: "no_admins", due: due.length };
  }

  const out: Record<string, unknown>[] = [];
  for (const t of due as Array<ReminderTicket & { chat_id: number }>) {
    // claim: stamp reminded_at only if still open and still due — an answer or another run in between wins
    const { data: claimed } = await admin.from("support_tickets").update({ reminded_at: new Date(now).toISOString() })
      .eq("id", t.id).eq("status", "open").or(`reminded_at.is.null,reminded_at.lt.${cutoff}`).select("id");
    if (!Array.isArray(claimed) || !claimed.length) continue;

    const text = reminderCard(t, now);
    const media = ticketMessages(t.messages).filter((m) => m.media && m.message_id).slice(0, MAX_COPIES);
    const sentTo: Array<{ chat: number; msg: number }> = [];
    for (const chat of admins.ids) {
      const r = await io.send("sendMessage", {
        chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: ticketKeyboard(t.id),
      });
      const card = Number(r.result?.message_id);
      if (!r.ok || !Number.isSafeInteger(card)) continue;
      sentTo.push({ chat, msg: card });
      for (const m of media) {
        const cp = await io.send("copyMessage", {
          chat_id: chat, from_chat_id: t.chat_id, message_id: m.message_id,
          reply_parameters: { message_id: card, allow_sending_without_reply: true },
        });
        const id = Number(cp.result?.message_id);
        if (cp.ok && Number.isSafeInteger(id)) sentTo.push({ chat, msg: id });
      }
    }
    if (sentTo.length) {
      // a Reply on the reminder (or its copies) answers the ticket, like the original card
      const { error: ae } = await admin.rpc("support_ticket_append", { _id: t.id, _messages: [], _admin_messages: sentTo });
      if (ae) {
        await logHealth(admin, "support_ticket_append_failed", { ticket_id: t.id, error: String(ae.message ?? ae).slice(0, 200), via: "reminder" },
          { source: "support-reminder" });
      }
    } else {
      // nobody got it: un-claim so the next run tries again, and make it visible
      await admin.from("support_tickets").update({ reminded_at: null }).eq("id", t.id).eq("status", "open");
      await logHealth(admin, "support_reminder_undelivered", { ticket_id: t.id, admins: admins.ids.length }, { source: "support-reminder" });
    }
    out.push({ ticket: t.id, delivered: sentTo.length });
  }
  return { status: "ok", reminded: out };
}
