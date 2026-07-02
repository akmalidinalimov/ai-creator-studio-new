// Webhook idempotency helpers (M10 / audit BOT-1).
//
// Telegram retries any update it doesn't get a 200 for within ~60s. The stats
// and homework handlers do many sequential round-trips and can exceed that, so
// without a dedupe guard a single user action can run twice (double /galaba
// send, double broadcast, double analytics event). We record each update_id in
// a UNIQUE table and short-circuit on the second delivery.
//
// These two functions are pure so they can be unit-tested without a DB or the
// Telegram runtime; the actual insert lives in index.ts against the service
// client. The guard is fail-OPEN: any error other than a unique violation
// (e.g. the table not existing yet) falls through to normal processing.

/** Extract a numeric update_id, or null if the payload doesn't carry one. */
export function parseUpdateId(update: unknown): number | null {
  if (update && typeof update === "object" && "update_id" in update) {
    const id = (update as { update_id: unknown }).update_id;
    if (typeof id === "number" && Number.isFinite(id)) return id;
  }
  return null;
}

/**
 * True if a Postgres error represents a unique-constraint violation — i.e. this
 * update_id was already recorded, so we're seeing a Telegram retry.
 */
export function isDuplicateError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "23505") return true;
  return typeof err.message === "string" && /duplicate key value/i.test(err.message);
}
