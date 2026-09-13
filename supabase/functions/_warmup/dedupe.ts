// _warmup/dedupe.ts — the idempotency key. SPEC §3: sha256(telegram_id | source_ref | action | plugin).
//
// Telegram redelivers an update whenever the webhook is slow to answer, cron ticks overlap, and a
// dispatch retry replays an event. Every one of those paths ends at warmup.ledger, whose
// dedupe_key is UNIQUE — so the second arrival collides and awards nothing. That collision is the
// mechanism the whole "replay a fixture twice, totals unchanged" requirement rests on.
//
// The key must therefore be a pure function of what the award IS, never of when it was computed:
// no timestamp, no random, no attempt counter. Same action by the same person on the same source
// from the same plugin = same key, forever.

// KNOWN LIMIT, accepted deliberately. The format SPEC §3 mandates joins on "|" without escaping,
// so a "|" inside a value is ambiguous: ("a|b","c") and ("a","b|c") hash identically. Safe today
// because every sourceRef and action is engine-generated from ids and fixed verbs, never from
// participant text. If a plugin ever derives a sourceRef from user input, escape it there — do
// not change this format, or every key already in warmup.ledger stops matching and the whole
// table replays.

const enc = new TextEncoder();

/** Lowercase hex SHA-256. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The ledger idempotency key, exactly as SPEC §3 defines it.
 *
 * `sourceRef` is what makes two otherwise identical awards distinct — the message, reaction or
 * code word the award is FOR (e.g. `msg:-100123:456`, `react:-100123:789`, `code:live_d1:apple`).
 * Passing something that varies per delivery (a timestamp, an update_id) silently defeats the
 * whole mechanism: every replay would produce a fresh key and award again. Passing something too
 * coarse (just the chat id) collapses distinct awards into one. It is the single field worth
 * getting right.
 */
export function ledgerDedupeKey(
  telegramId: number,
  sourceRef: string,
  action: string,
  plugin: string,
): Promise<string> {
  return sha256Hex(`${telegramId}|${sourceRef}|${action}|${plugin}`);
}

/**
 * Key for a queued send, so the same outbox row cannot be enqueued twice (warmup.outbox.dedupe_key
 * is UNIQUE). Distinct from the ledger key: a send is identified by who/what/when-slot, not by an
 * award. `slot` should be whatever makes this send unique for the day — a slot id, a nudge kind, a
 * countdown offset.
 */
export function sendDedupeKey(
  recipient: number | string,
  copyKeyOrTemplate: string,
  slot: string,
  campaignDay: number | null,
): Promise<string> {
  return sha256Hex(`send|${recipient}|${copyKeyOrTemplate}|${slot}|${campaignDay ?? "-"}`);
}
