// One canonical "send a Telegram message AND record the outcome" helper for edge functions.
//
// WHY: there are ~37 hand-rolled `fetch("https://api.telegram.org/…")` senders across 31 functions,
// most of which don't inspect the response — so a student's grade DM (or a completion celebration,
// or a nudge) can silently fail to deliver with no trace. This makes non-delivery DB-visible BY
// CONSTRUCTION: it classifies the outcome (accepted / terminal-recipient / terminal-content /
// transient) via the shared classifier and writes a health row on any real non-delivery.
//
// The bot token is used only inside this function (in the request URL) and is NEVER returned, logged,
// or placed in the recorded `error` (which is only Telegram's `description`, e.g. "bot was blocked").
//
// "Recipient" errors are the ~70%-of-students case (never pressed Start / blocked the bot): a terminal
// non-delivery that is EXPECTED and high-volume — callers/watchdogs should treat a spike of the OTHER
// classes (transient/content) as the real alarm, and recipient non-delivery as a reach metric.

import { tgResult, isTerminal, isRecipientError, isContentError } from "./telegram-classify.ts";
import { logHealth } from "./edge.ts";

export type SendOutcome = {
  ok: boolean;            // Telegram accepted the send
  status: number;         // Telegram HTTP status (0 = transport error)
  error: string | null;   // Telegram `description` or `http_<status>` — never the token
  terminal: boolean;      // recipient/content error → retrying won't help
  recipient: boolean;     // recipient can't be reached (blocked / never pressed Start / chat not found)
  content: boolean;       // payload will never render (caption too long / bad media / …)
};

/**
 * Send a Telegram Bot API method and (by default) record any non-delivery to `admin_actions`.
 * `method` e.g. "sendMessage" | "sendAudio" | "sendDocument". Never throws — a transport error resolves
 * to a transient outcome. Returns the classified outcome so callers can branch (skip retry on terminal,
 * count recipient reach, etc.). Pass `record:false` to only classify (e.g. inside a queue drainer that
 * writes its own per-row status).
 */
/** Shared non-delivery recorder for both the JSON and multipart senders (see sendTelegram's doc). */
async function recordNonDelivery(
  outcome: SendOutcome,
  method: string,
  opts?: { admin?: any; purpose?: string; recipientId?: string | number | null; record?: boolean },
): Promise<void> {
  if (outcome.ok || opts?.record === false) return;
  if (opts?.admin) {
    await logHealth(
      opts.admin,
      "telegram_send_failed",
      {
        method,
        purpose: opts?.purpose ?? method,
        recipient: opts?.recipientId ?? null,
        error: outcome.error, // Telegram description only — never the token
        terminal: outcome.terminal,
        recipient_error: outcome.recipient,
        content_error: outcome.content,
      },
      { source: "telegram-send" },
    );
  } else {
    console.error("sendTelegram: non-delivery NOT recorded (no admin client passed)", {
      method,
      purpose: opts?.purpose ?? method,
      error: outcome.error,
    });
  }
}

/**
 * Multipart (FILE UPLOAD) sibling of sendTelegram, for methods that take a real file rather than a
 * file_id/URL — sendPhoto / sendVideo / sendDocument with binary content. Same token containment, same
 * classification + health recording; additionally returns Telegram's `result` (the sent Message), which the
 * caller needs for `message_id` and the resulting `file_id`.
 *
 * Telegram's BOT upload ceilings apply here and cannot be raised: ~10MB per photo, ~50MB per video/document.
 * A larger file comes back as a terminal content error — callers should pre-check size and offer a fallback.
 */
export async function sendTelegramMultipart(
  botToken: string,
  method: string,
  fields: Record<string, string | number>,
  file: { field: string; blob: Blob; filename: string },
  opts?: { admin?: any; purpose?: string; recipientId?: string | number | null; record?: boolean },
): Promise<{ outcome: SendOutcome; result: any }> {
  let status = 0;
  let j: { ok?: boolean; description?: string; result?: unknown } | null = null;
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    form.append(file.field, file.blob, file.filename);
    // No explicit Content-Type: fetch sets multipart/form-data + the boundary from the FormData body.
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
    status = resp.status;
    j = await resp.json().catch(() => null);
  } catch {
    j = { ok: false, description: "transport_error" };
  }

  const { ok, error } = tgResult(j, status);
  const outcome: SendOutcome = {
    ok,
    status,
    error,
    terminal: isTerminal(error),
    recipient: isRecipientError(error),
    content: isContentError(error),
  };
  await recordNonDelivery(outcome, method, opts);
  return { outcome, result: (j as { result?: unknown } | null)?.result ?? null };
}

export async function sendTelegram(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  opts?: { admin?: any; purpose?: string; recipientId?: string | number | null; record?: boolean },
): Promise<SendOutcome> {
  let status = 0;
  let j: { ok?: boolean; description?: string } | null = null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    status = resp.status;
    j = await resp.json().catch(() => null);
  } catch {
    // Network/transport failure — transient. No token in the recorded description.
    j = { ok: false, description: "transport_error" };
  }

  const { ok, error } = tgResult(j, status);
  const outcome: SendOutcome = {
    ok,
    status,
    error,
    terminal: isTerminal(error),
    recipient: isRecipientError(error),
    content: isContentError(error),
  };

  // Non-delivery is made DB-visible here (or logged loudly when no admin client was passed) — see
  // recordNonDelivery. Callers that write their own per-row status opt out with `record:false`.
  await recordNonDelivery(outcome, method, opts);

  return outcome;
}
