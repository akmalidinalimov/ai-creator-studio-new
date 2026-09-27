// Teacher /tbroadcast DM fan-out: send to each recipient and COUNT REAL DELIVERY.
//
// Kept pure (the sender and the side effects are injected) so the counting rule is CI-tested in
// broadcast-fanout.test.ts — telegram-bot-webhook/index.ts itself is not type-checked in CI.
//
// The rule: a recipient counts as delivered ONLY when Telegram accepted the send (HTTP ok AND the JSON
// `ok`, as classified by _shared/telegram-send.ts). A blocked bot / a student who never pressed Start /
// a deactivated account comes back as an ordinary 403/400 with {ok:false} — it does NOT throw — so the
// old "count every send that didn't throw" loop reported those students as reached.
//
// Health signals (member-forgiveness): a RECIPIENT-class miss is expected member reach, so it produces no
// per-recipient signal at all — only the caller's one summary row. A NON-recipient failure (transport,
// flood control, unparseable content, an exception) is a real fault and is handed to `onFault` so the
// caller can feed the existing "Telegram itself is failing" detectors.
import type { SendOutcome } from "../_shared/telegram-send.ts";

export type BroadcastTally = {
  sent: number;         // Telegram accepted the DM
  failed: number;       // total - sent
  total: number;        // recipients attempted (students with a telegram_id)
  unreachable: number;  // recipient-class misses: blocked / never pressed Start / chat not found / deactivated
  other_failed: number; // transient or content-class: a real delivery fault, not member behaviour
  errors: Record<string, number>; // Telegram `description` → count (never the bot token)
};

// Bounds the jsonb written to admin_actions: "Too Many Requests: retry after N" varies per call.
export const MAX_ERROR_KEYS = 10;

// What a thrown sender is recorded as. Non-terminal and unclassified on purpose: an unknown fault should
// look like one to the watchdogs, not hide inside a known transient pattern.
const EXCEPTION_OUTCOME: SendOutcome = {
  ok: false, status: 0, error: "exception", terminal: false, recipient: false, content: false,
};

export async function fanOutBroadcast<R>(
  recipients: readonly R[],
  send: (r: R) => Promise<SendOutcome>,
  onDelivered: (r: R) => PromiseLike<unknown>, // e.g. a supabase-js insert builder (awaited here)
  onFault: (r: R, outcome: SendOutcome) => PromiseLike<unknown>,
): Promise<BroadcastTally> {
  const tally: BroadcastTally = {
    sent: 0, failed: 0, total: recipients.length, unreachable: 0, other_failed: 0, errors: {},
  };
  for (const r of recipients) {
    let out: SendOutcome;
    try {
      out = await send(r);
    } catch (_e) {
      // sendTelegram never throws by contract (a transport error resolves to a transient outcome); this is
      // belt-and-braces so one bad recipient can never abort the rest of the fan-out.
      out = EXCEPTION_OUTCOME;
    }
    if (out.ok) {
      tally.sent++;
      try {
        await onDelivered(r);
      } catch (_e) { /* the ledger write is best-effort; the DM was delivered either way */ }
      continue;
    }
    if (out.recipient) {
      tally.unreachable++;
    } else {
      tally.other_failed++;
      try {
        await onFault(r, out);
      } catch (_e) { /* signalling is best-effort; never abort the fan-out */ }
    }
    const k = (out.error || "unknown").slice(0, 80);
    if (k in tally.errors || Object.keys(tally.errors).length < MAX_ERROR_KEYS) {
      tally.errors[k] = (tally.errors[k] || 0) + 1;
    } else {
      tally.errors.other = (tally.errors.other || 0) + 1;
    }
  }
  tally.failed = tally.total - tally.sent;
  return tally;
}
