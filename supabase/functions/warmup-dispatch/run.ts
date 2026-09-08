// warmup-dispatch/run.ts — the dispatch loop, separated from the HTTP wrapper so it can be tested.
//
// Modelled on broadcast-drainer's hardened loop: an atomic claim lease so overlapping ticks cannot
// process the same event twice, a retry cap so a poison event cannot spin forever, and per-row
// error recording so a failure is DB-visible instead of living only in function logs.

import { applyEffects } from "../_warmup/applier.ts";
import { buildCtx, dispatchEvent, loadFlags } from "../_warmup/bus.ts";
import { campaignDayFor, loadActivePack } from "../_warmup/pack.ts";
import { warmupEnabled } from "../_warmup/tg.ts";
import type { Event, EventType } from "../_warmup/types.ts";

export const BATCH = 100;
export const MAX_ATTEMPTS = 5;
export const CLAIM_LEASE_MS = 90_000;

export interface DispatchResult {
  ok: boolean;
  processed: number;
  failed: number;
  effectsApplied: number;
  effectsDeduped: number;
  pluginErrors: number;
  note?: string;
  error?: string;
}

const EMPTY: DispatchResult = {
  ok: true, processed: 0, failed: 0, effectsApplied: 0, effectsDeduped: 0, pluginErrors: 0,
};

export async function runDispatch(admin: any, now: Date = new Date()): Promise<DispatchResult> {
  // Kill switch: claim nothing. Events stay unprocessed and are picked up when the switch goes
  // back on — points are awarded late, never lost. Letting dispatch run while the drainer is muted
  // would build an outbox that floods the moment the switch flips.
  if (!(await warmupEnabled(admin))) return { ...EMPTY, note: "warmup_disabled" };

  const wm = admin.schema("warmup");
  const nowIso = now.toISOString();
  const claimCutoff = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const leaseFilter = `claimed_at.is.null,claimed_at.lt.${claimCutoff}`;

  const { data: cand, error: selErr } = await wm.from("events")
    .select("id")
    .is("processed_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .or(leaseFilter)
    .order("id", { ascending: true })
    .limit(BATCH);
  if (selErr) return { ...EMPTY, ok: false, error: selErr.message };

  const ids = (cand || []).map((r: { id: number }) => r.id);
  if (!ids.length) return { ...EMPTY };

  // Atomic claim — only rows still free come back, so a concurrent tick gets none of them.
  const { data: claimed } = await wm.from("events")
    .update({ claimed_at: nowIso })
    .in("id", ids)
    .is("processed_at", null)
    .or(leaseFilter)
    .select("id, event_type, telegram_id, chat_id, message_id, payload, created_at, attempts");
  const rows = (claimed || []) as Record<string, any>[];
  if (!rows.length) return { ...EMPTY };

  let pack;
  try {
    pack = await loadActivePack(admin);
  } catch (e) {
    // Without a pack no plugin can decide anything. Release the claims so these events are retried
    // once a pack is active, rather than burning an attempt each on a condition they did not cause.
    await wm.from("events").update({ claimed_at: null }).in("id", rows.map((r) => r.id));
    return { ...EMPTY, ok: false, error: `no_active_pack: ${String((e as Error)?.message ?? e)}` };
  }

  const flags = await loadFlags(admin);
  const ctx = buildCtx(admin, pack, () => now);

  const out: DispatchResult = { ...EMPTY };

  for (const row of rows) {
    const event: Event = {
      id: row.id,
      type: row.event_type as EventType,
      telegramId: row.telegram_id ?? undefined,
      chatId: row.chat_id ?? undefined,
      messageId: row.message_id ?? undefined,
      payload: row.payload ?? {},
      createdAt: row.created_at,
    };

    try {
      const campaignDay = campaignDayFor(pack, new Date(event.createdAt));
      const results = await dispatchEvent(admin, event, ctx, flags);

      for (const r of results) {
        if (!r.ok) out.pluginErrors++;
        if (!r.effects.length) continue;
        // Applied per plugin so ledger.plugin attributes each award to whoever decided it.
        const report = await applyEffects(admin, pack, r.effects, {
          plugin: r.plugin, campaignDay, eventId: event.id,
        });
        out.effectsApplied += report.applied;
        out.effectsDeduped += report.deduped;
        if (report.errors.length) {
          console.error("warmup-dispatch: applier errors",
            { event: event.id, plugin: r.plugin, errors: report.errors });
        }
      }

      // A plugin failing is NOT an event failure. The event WAS dispatched; the bus recorded the
      // plugin's error and will disable it if it keeps happening. Re-running the event would
      // re-run every healthy plugin too, for no gain.
      await wm.from("events")
        .update({ processed_at: new Date().toISOString(), claimed_at: null }).eq("id", event.id);
      out.processed++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      console.error("warmup-dispatch: event failed", event.id, message);
      await wm.from("events").update({
        attempts: (row.attempts ?? 0) + 1, last_error: message.slice(0, 500), claimed_at: null,
      }).eq("id", event.id);
      out.failed++;
    }
  }

  return out;
}
