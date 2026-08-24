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

  if (!ok && opts?.record !== false) {
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
      // No admin client → the non-delivery can't be made DB-visible. Never leave it FULLY silent (the
      // failure class this helper exists to kill): log it loudly. Callers that want it recorded MUST
      // pass `admin`; only an explicit `record:false` (e.g. a queue drainer writing its own status) opts out.
      console.error("sendTelegram: non-delivery NOT recorded (no admin client passed)", {
        method,
        purpose: opts?.purpose ?? method,
        error: outcome.error, // Telegram description only — never the token
      });
    }
  }

  return outcome;
}
