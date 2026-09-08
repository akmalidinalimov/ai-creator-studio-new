// _warmup/governor.ts — decides whether a queued send may leave, and when.
//
// SPEC §6.5. Three rules, and the third is the one most likely to be got wrong:
//
//   1. Channel and DM budgets are SEPARATE and count differently. `channel_per_day` is a property
//      of the channel — 2 posts a day total, because 3+ measured a 30% reach drop. `dm_per_day` is
//      a property of a PERSON — 2 DMs each, not 2 DMs across the whole campaign. Counting either
//      one the other way is silently catastrophic: global DM counting would mean participant #3
//      onward never hears anything.
//
//   2. Quiet hours DEFER, budgets DROP. A quiet-hours block is about timing, so the message is
//      still wanted at 08:00. A budget block is about volume, and deferring would just spend
//      tomorrow's cap on yesterday's message, cascading the overflow forward forever.
//
//   3. kind:'reply' is PULL, not push. Someone spoke to the bot and is waiting. It draws on its
//      own per-user limit (pack.cm.limits.text_replies_per_user_per_day), never touches the push
//      budget, and is not held by quiet hours — the participant is demonstrably awake, they just
//      posted. Charging replies to the push budget would let a chatty afternoon silently eat the
//      evening scorecard.

import type { CampaignPack } from "./types.ts";
import { isEventDay, isQuietHour, nextWindowOpen, zonedDateKey, zonedTimeToInstant } from "./pack.ts";

export type GovernorVerdict =
  | { allow: true; reason: "within_budget" | "pull_not_push" | "unlimited" }
  | { allow: false; action: "defer"; until: string; reason: string }
  | { allow: false; action: "drop"; reason: string };

export interface GovernedItem {
  surface: "dm" | "channel" | "group";
  kind: "push" | "reply" | "render" | "react";
  telegramId?: number | null;
  chatId?: number | null;
}

/** Start of the current campaign day, in the pack timezone, as an ISO instant. */
export function dayStartIso(pack: CampaignPack, at: Date): string {
  const tz = pack.manifest.timezone;
  return zonedTimeToInstant(zonedDateKey(at, tz), "00:00", tz).toISOString();
}

/** Channel posts already sent today. Global — the budget belongs to the channel. */
async function channelSentToday(admin: any, pack: CampaignPack, at: Date): Promise<number> {
  const { count, error } = await admin.schema("warmup").from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("kind", "push")
    .in("surface", ["channel", "group"])
    .gte("sent_at", dayStartIso(pack, at));
  if (error) throw new Error(`governor: channel count failed: ${error.message}`);
  return count || 0;
}

/** DMs already pushed to THIS participant today. Per person — the budget belongs to the person. */
async function dmSentToday(admin: any, pack: CampaignPack, telegramId: number, at: Date): Promise<number> {
  const { count, error } = await admin.schema("warmup").from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("kind", "push").eq("surface", "dm")
    .eq("telegram_id", telegramId)
    .gte("sent_at", dayStartIso(pack, at));
  if (error) throw new Error(`governor: dm count failed: ${error.message}`);
  return count || 0;
}

/** Text replies already sent to this participant today, across every surface. */
async function repliesToday(admin: any, pack: CampaignPack, telegramId: number, at: Date): Promise<number> {
  const { count, error } = await admin.schema("warmup").from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("kind", "reply").eq("telegram_id", telegramId)
    .gte("sent_at", dayStartIso(pack, at));
  if (error) throw new Error(`governor: reply count failed: ${error.message}`);
  return count || 0;
}

/**
 * May this item be sent right now?
 *
 * Never throws for a policy reason — a refusal is a verdict, always carrying a reason the drainer
 * writes to outbox.drop_reason so a suppressed message is DB-visible rather than a silence nobody
 * can explain later. It DOES throw if the database is unreadable, because a governor that cannot
 * count must not be interpreted as permission.
 */
export async function govern(
  admin: any,
  pack: CampaignPack,
  item: GovernedItem,
  at: Date = new Date(),
): Promise<GovernorVerdict> {
  // Reactions are explicitly unlimited (§6.7) and are neither a push nor a reply: they must draw
  // on no budget at all. They also ignore quiet hours — a reaction makes no notification sound.
  if (item.kind === "react") return { allow: true, reason: "unlimited" };

  // Rule 3 — pull, not push.
  if (item.kind === "reply") {
    const limit = pack.cm?.limits?.text_replies_per_user_per_day;
    if (item.telegramId && typeof limit === "number") {
      const used = await repliesToday(admin, pack, item.telegramId, at);
      if (used >= limit) {
        // Dropped, not deferred: tomorrow's reply to a question asked today is worse than silence.
        return { allow: false, action: "drop", reason: `reply_limit_reached:${used}/${limit}` };
      }
    }
    return { allow: true, reason: "pull_not_push" };
  }

  // 'render' is an internal step, not a delivery; the send it produces is governed on its own.
  if (item.kind === "render") return { allow: true, reason: "within_budget" };

  // Rule 2 — quiet hours defer.
  if (isQuietHour(pack, at)) {
    return {
      allow: false, action: "defer",
      until: nextWindowOpen(pack, at).toISOString(),
      reason: `quiet_hours:${pack.schedule.quiet_hours.from}-${pack.schedule.quiet_hours.to}`,
    };
  }

  // Rule 1 — separate budgets, counted differently.
  if (item.surface === "dm") {
    if (!item.telegramId) return { allow: false, action: "drop", reason: "dm_without_recipient" };
    const limit = pack.schedule.budgets.dm_per_day;
    const used = await dmSentToday(admin, pack, item.telegramId, at);
    if (used >= limit) return { allow: false, action: "drop", reason: `dm_budget_exhausted:${used}/${limit}` };
    return { allow: true, reason: "within_budget" };
  }

  const limit = isEventDay(pack, at)
    ? (pack.schedule.budgets.event_day_channel ?? pack.schedule.budgets.channel_per_day)
    : pack.schedule.budgets.channel_per_day;
  const used = await channelSentToday(admin, pack, at);
  if (used >= limit) return { allow: false, action: "drop", reason: `channel_budget_exhausted:${used}/${limit}` };
  return { allow: true, reason: "within_budget" };
}
