// warmup-webhook/ingest.ts — the ingestion core, separated from the HTTP wrapper so it can be
// tested without binding a port or reaching Telegram.

import { normalise } from "./normalise.ts";
import type { CampaignPack } from "../_warmup/types.ts";

export interface IngestResult {
  ingested: number;
  deduped: number;
  error?: string;
}

/**
 * Normalise one Telegram update and record it in warmup.events.
 *
 * Idempotent by construction: the upsert targets the partial unique index on
 * (update_id, event_type), so a Telegram redelivery of the same update inserts nothing. This is
 * the first of the two idempotency layers protecting the "same payload twice → one ledger row"
 * guarantee; ledger.dedupe_key is the second, and either alone is sufficient.
 */
export async function ingestUpdate(
  admin: any,
  pack: CampaignPack | null,
  update: Record<string, unknown>,
): Promise<IngestResult> {
  const updateId = typeof update.update_id === "number" ? update.update_id : null;

  let events;
  try {
    events = normalise(update, pack);
  } catch (e) {
    // A malformed update must never cost us the raw record: store it unclassified rather than
    // dropping something we cannot ask Telegram to send again.
    console.error("warmup-webhook: normalise threw", String((e as Error)?.message ?? e));
    events = [{ type: "message.posted" as const, payload: { normaliseError: true } }];
  }

  // Nothing actionable: an anonymous channel reaction, a bot's own message, a reaction removal.
  if (!events.length) return { ingested: 0, deduped: 0 };

  const rows = events.map((e) => ({
    event_type: e.type,
    telegram_id: e.telegramId ?? null,
    chat_id: e.chatId ?? null,
    message_id: e.messageId ?? null,
    payload: { ...e.payload, raw: update },
    update_id: updateId,
  }));

  const { data, error } = await admin.schema("warmup").from("events")
    .upsert(rows, { onConflict: "update_id,event_type", ignoreDuplicates: true })
    .select("id");

  if (error) return { ingested: 0, deduped: 0, error: error.message };

  const ingested = (data || []).length;
  return { ingested, deduped: rows.length - ingested };
}
