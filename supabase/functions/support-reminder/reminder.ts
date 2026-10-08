// support-reminder — while «❓ Yordam» tickets stay unanswered, the admins get ONE summary every `every_min`
// (default 300 = 5 h; owner 2026-10-08: the hourly re-send of every ticket was too noisy — "new ones arrive and after a
// couple of hours the old ones are resubmitting; it needs to be more structured"). The summary is the inbox's:
// 🆕 new (< new_hours) · ⏳ older open · the oldest wait, with [🆕 Yangilar] [⏳ Eskilar] buttons that open the lists
// and each ticket (telegram-bot-webhook/support-inbox-bot.ts). A brand-new ticket still reaches the admins at once
// (support.ts); this only nags about the ones still waiting.
//
// Settings: platform_settings.support_reminders = {enabled, every_min, quiet_start_hour, quiet_end_hour, new_hours}.
// Due tickets are CLAIMED (reminded_at stamped atomically) before the summary is sent: overlapping runs never double-send.
// Backstop: support_tickets_watchdog (SQL, :27) still DMs a list of tickets older than 3 h nobody reminded in 12 h.
//
// Pure except for the injected I/O (reminder.test.ts runs it with fakes). index.ts is the HTTP shell.

import { logHealth } from "../_shared/edge.ts";
import { adminTelegramIds } from "../_shared/admin-recipients.ts";
import { isQuietHour } from "../_shared/support-reminder-card.ts";
import { bucketize, fetchOpenTickets, newHoursOf, renderInboxSummary } from "../_shared/support-inbox.ts";

type Db = any;
export type SendFn = (method: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result: any; error: string | null }>;
export interface Io { admin: Db; send: SendFn; now: () => number }

export const DEFAULTS = { enabled: true, every_min: 300, quiet_start_hour: 23, quiet_end_hour: 8, new_hours: 6 };

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
    new_hours: newHoursOf(o),
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
  // a strict cadence: at most ONE summary per every_min, however the tickets' own clocks are staggered
  const { data: last } = await admin.from("admin_actions").select("created_at").eq("action", "support_reminder_sent")
    .gte("created_at", cutoff).limit(1);
  if (Array.isArray(last) && last.length) return { status: "cadence" };
  // claim every due ticket at once: open, waiting longer than every_min, not summarised within every_min
  const { data: claimed, error } = await admin.from("support_tickets").update({ reminded_at: new Date(now).toISOString() })
    .eq("status", "open").lt("created_at", cutoff).or(`reminded_at.is.null,reminded_at.lt.${cutoff}`).select("id");
  if (error) throw new Error(`support_tickets: ${String(error.message ?? error).slice(0, 200)}`);
  const ids = ((claimed ?? []) as Array<{ id: number }>).map((r) => r.id);
  if (!ids.length) return { status: "idle" };

  const unclaim = async (why: string, adminsN: number) => {
    await admin.from("support_tickets").update({ reminded_at: null }).in("id", ids).eq("status", "open");
    await logHealth(admin, "support_reminder_undelivered", { tickets: ids, admins: adminsN, why }, { source: "support-reminder" });
  };
  try {
    const admins = await adminTelegramIds(admin);
    if (!admins.ids.length) {
      await unclaim(admins.error ?? "no_admins", 0);
      return { status: "no_admins", due: ids.length };
    }

    const summary = renderInboxSummary(bucketize(await fetchOpenTickets(admin), now, cfg.new_hours), now, cfg.new_hours,
      "🔔 <b>Javobsiz murojaatlar</b>");
    let delivered = 0;
    for (const chat of admins.ids) {
      const r = await io.send("sendMessage", {
        chat_id: chat, text: summary.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: summary.keyboard,
      });
      if (r.ok) delivered++;
    }
    if (!delivered) {
      await unclaim("send_failed", admins.ids.length);
      return { status: "undelivered", due: ids.length };
    }
    // the cadence marker + a health signal (and the admins it missed, if any)
    await logHealth(admin, "support_reminder_sent", { tickets: ids, delivered, failed: admins.ids.length - delivered },
      { source: "support-reminder" });
    return { status: "ok", due: ids.length, delivered };
  } catch (e) {
    // never leave tickets claimed without a summary (they would stay silent for another every_min)
    await unclaim(String((e as any)?.message ?? e).slice(0, 200), -1);
    throw e;
  }
}
