// _warmup/applier.ts — THE ONLY CODE THAT WRITES TO THE DATABASE.
//
// Plugins are pure: they read through Ctx and return Effect[]. Everything that changes state
// happens here. That is what makes a misbehaving plugin a contained problem — the worst it can do
// is return a bad effect, which this file validates, applies in isolation, and reports on.
//
// SPEC §1's architecture is followed exactly: this file writes warmup.ledger and warmup.outbox and
// nothing else talks to Telegram. Reactions are QUEUED, not sent inline, even though they are
// unlimited and cheap — routing every outbound thing through one queue means one kill switch, one
// retry path, and one table to query when someone asks why the bot did not respond.
//
// Two hard boundaries:
//   • Nothing in the public schema is written. Ever. Not even a health row.
//   • warmup.ledger is append-only — insert or skip, never update. A duplicate dedupe_key is a
//     SUCCESS (the award already exists), not an error.

import type { CampaignPack, Effect } from "./types.ts";
import { ledgerDedupeKey } from "./dedupe.ts";

export interface ApplyContext {
  /** Plugin that produced these effects — recorded on every ledger row for attribution. */
  plugin: string;
  campaignDay: number | null;
  /** warmup.events.id this batch came from, for tracing. */
  eventId?: number | null;
}

export interface ApplyReport {
  applied: number;
  /** Effects that were correctly no-ops: an award already in the ledger, a send already queued. */
  deduped: number;
  awardedPoints: number;
  errors: { kind: string; message: string }[];
}

/** A "row already exists" outcome. Idempotency working, not a failure. */
function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key|already exists/i.test(error.message || "");
}

export async function applyEffects(
  admin: any,
  pack: CampaignPack,
  effects: Effect[],
  ctx: ApplyContext,
): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, deduped: 0, awardedPoints: 0, errors: [] };
  const wm = admin.schema("warmup");

  for (const effect of effects) {
    try {
      switch (effect.kind) {
        // ── award ────────────────────────────────────────────────────────────
        // The idempotency point of the whole system. dedupe_key is UNIQUE, so a replayed event
        // collides here and awards nothing. Insert-and-tolerate-conflict, never read-then-write:
        // two concurrent dispatch ticks would both read "not present" and both insert.
        case "award": {
          if (!Number.isFinite(effect.telegramId) || !Number.isFinite(effect.points)) {
            report.errors.push({ kind: "award", message: "telegramId and points must be numbers" });
            break;
          }
          const key = await ledgerDedupeKey(effect.telegramId, effect.sourceRef, effect.action, ctx.plugin);
          const { data, error } = await wm.from("ledger").insert({
            telegram_id: effect.telegramId,
            action: effect.action,
            points: effect.points,
            reason: effect.reason ?? null,
            plugin: ctx.plugin,
            campaign_day: ctx.campaignDay,
            source_ref: effect.sourceRef,
            dedupe_key: key,
          }).select("id").maybeSingle();

          if (error) {
            if (isDuplicate(error)) { report.deduped++; break; }
            throw new Error(error.message);
          }
          if (data) { report.applied++; report.awardedPoints += effect.points; }
          else report.deduped++;
          break;
        }

        // ── send ─────────────────────────────────────────────────────────────
        // Queued only. The governor runs at drain time, not here: budgets are about the moment of
        // delivery, and an effect queued at 21:59 may legitimately be sent at 08:00 tomorrow.
        case "send": {
          if (!effect.telegramId && !effect.chatId) {
            report.errors.push({ kind: "send", message: "send needs telegramId or chatId" });
            break;
          }
          const { error } = await wm.from("outbox").insert({
            telegram_id: effect.telegramId ?? null,
            chat_id: effect.chatId ?? null,
            surface: effect.surface,
            kind: effect.msgKind,
            payload: effect.payload,
            scheduled_for: effect.scheduledFor ?? new Date().toISOString(),
            dedupe_key: effect.dedupeKey ?? null,
          });
          if (error) {
            if (isDuplicate(error)) { report.deduped++; break; }
            throw new Error(error.message);
          }
          report.applied++;
          break;
        }

        // ── react ────────────────────────────────────────────────────────────
        // kind='react' extends SPEC's push|reply|render vocabulary. Reactions are unlimited
        // (§6.7), so they must not draw on the push budget, and they are not replies, so they must
        // not draw on the per-user reply limit. Their own kind is the honest way to say that.
        case "react": {
          const { error } = await wm.from("outbox").insert({
            chat_id: effect.chatId,
            surface: "group",
            kind: "react",
            payload: { emoji: effect.emoji, messageId: effect.messageId },
            scheduled_for: new Date().toISOString(),
            // One reaction per bot per message: a replay must not re-react.
            dedupe_key: `react|${effect.chatId}|${effect.messageId}|${effect.emoji}`,
          });
          if (error) {
            if (isDuplicate(error)) { report.deduped++; break; }
            throw new Error(error.message);
          }
          report.applied++;
          break;
        }

        // ── render ───────────────────────────────────────────────────────────
        // Queued for warmup-render (Agent B). The image is produced, then re-queued as a send.
        case "render": {
          const { error } = await wm.from("outbox").insert({
            surface: effect.then === "dm" ? "dm" : "channel",
            kind: "render",
            payload: { template: effect.template, data: effect.data, then: effect.then },
            scheduled_for: new Date().toISOString(),
          });
          if (error) throw new Error(error.message);
          report.applied++;
          break;
        }

        // ── setSegment ───────────────────────────────────────────────────────
        case "setSegment": {
          const { error } = await wm.from("participants")
            .update({ segment: effect.segment }).eq("telegram_id", effect.telegramId);
          if (error) throw new Error(error.message);
          report.applied++;
          break;
        }

        // ── setState ─────────────────────────────────────────────────────────
        // Plugin-owned scratch space. Conflict target is the generated scope_id, which is what
        // lets telegram_id stay NULL for plugin-global state (see the migration's DELTA-4).
        case "setState": {
          const { error } = await wm.from("plugin_state").upsert({
            plugin: effect.plugin,
            telegram_id: effect.telegramId ?? null,
            key: effect.key,
            value: effect.value as unknown,
            updated_at: new Date().toISOString(),
          }, { onConflict: "plugin,scope_id,key" });
          if (error) throw new Error(error.message);
          report.applied++;
          break;
        }

        // ── escalate ─────────────────────────────────────────────────────────
        case "escalate": {
          const { error } = await wm.from("escalations").insert({
            telegram_id: effect.telegramId,
            question: effect.question,
            category: effect.category,
            heat_flag: effect.heatFlag,
          });
          if (error) throw new Error(error.message);
          report.applied++;
          break;
        }

        // ── awardBadge ───────────────────────────────────────────────────────
        // Recorded warm-up-side only. AGENTS.md wants Slice 9 to reuse the LMS badge pipeline
        // (public.badge_award_queue / queue_badge_dm), but that is a write to the public schema,
        // which this subsystem is forbidden from doing. Bridging the two needs an explicit
        // exception decided in Slice 9 — until then the award is durable here and nothing is lost.
        case "awardBadge": {
          const { error } = await wm.from("plugin_state").upsert({
            plugin: "badges",
            telegram_id: effect.telegramId,
            key: `badge:${effect.badgeKey}`,
            value: { badge_key: effect.badgeKey, awarded_at: new Date().toISOString() },
            updated_at: new Date().toISOString(),
          }, { onConflict: "plugin,scope_id,key" });
          if (error) throw new Error(error.message);
          report.applied++;
          break;
        }

        default: {
          const unknown = effect as { kind?: string };
          report.errors.push({ kind: String(unknown?.kind ?? "?"), message: "unknown effect kind" });
        }
      }
    } catch (e) {
      // One bad effect must not abandon the rest of the batch — the others are already-earned
      // points and already-decided messages.
      report.errors.push({ kind: (effect as { kind?: string })?.kind ?? "?", message: String((e as Error)?.message ?? e) });
    }
  }

  return report;
}
