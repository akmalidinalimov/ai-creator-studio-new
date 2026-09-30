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

import { tgResult, isTerminal, isRecipientError, isContentError, classifySend, type SendClass } from "./telegram-classify.ts";
import { logHealth, logHealthOnce } from "./edge.ts";

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

// ── sendTelegramWithResult (Daily Tasks PR-4, spec G7 / §11.7) ─────────────────────────────────────────────
// ADDITIVE sibling of sendTelegram for callers that need (a) Telegram's `result` (the sent Message → its
// message_id, which a receipt must be recorded with) and (b) the finer SendClass. sendTelegram's contract and
// classification are untouched. Differences, all by class:
//   not_modified → ok:true, nothing recorded (an edit whose desired state already holds).
//   rate_limited → NOT a telegram_send_failed row (flow control, not breakage, so telegram_send_broken_24h is
//                  not inflated); ONE 'telegram_rate_limited' row per (method, chat, minute) instead, with
//                  retry_after. terminal:false, so the caller leaves the work for a paced retry.
//   topic_missing / message_gone → terminal:true. With opts.topicMissingAction the topic class is recorded
//                  under THAT action (e.g. 'challenge_task_topic_missing', which the daily-task watchdog alarms
//                  on) instead of telegram_send_failed; without it, telegram_send_failed as before.
//   recipient / content / transient → exactly sendTelegram's recording (recordNonDelivery).
export type SendResultOutcome = SendOutcome & { klass: SendClass; retryAfterSec: number | null };

function minuteStartIso(now: Date = new Date()): string {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
}

export type SendResultOpts = {
  admin?: any;
  purpose?: string;
  recipientId?: string | number | null;
  record?: boolean;
  topicMissingAction?: string;
};

type BotApiJson = { ok?: boolean; description?: string; result?: unknown; parameters?: { retry_after?: unknown } } | null;

export async function sendTelegramWithResult(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  opts?: SendResultOpts,
): Promise<{ outcome: SendResultOutcome; result: any }> {
  let status = 0;
  let j: BotApiJson = null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    status = resp.status;
    j = await resp.json().catch(() => null);
  } catch {
    j = { ok: false, description: "transport_error" }; // no token in the recorded description
  }
  return await resolveWithResult(j, status, method, payload, opts);
}

/** The classification + recording half of sendTelegramWithResult, shared with the multipart siblings below. */
async function resolveWithResult(
  j: BotApiJson,
  status: number,
  method: string,
  payload: Record<string, unknown>,
  opts?: SendResultOpts,
): Promise<{ outcome: SendResultOutcome; result: any }> {
  const c = classifySend(j, status);
  const ok = c.klass === "ok" || c.klass === "not_modified";
  const outcome: SendResultOutcome = {
    ok,
    status,
    error: c.klass === "ok" ? null : c.error,
    terminal: ["recipient", "content", "topic_missing", "message_gone"].includes(c.klass),
    recipient: c.klass === "recipient",
    content: c.klass === "content",
    klass: c.klass,
    retryAfterSec: c.retryAfterSec,
  };
  const result = ok ? ((j as { result?: unknown } | null)?.result ?? null) : null;
  if (ok || opts?.record === false) return { outcome, result };

  const chatKey = String((payload as { chat_id?: unknown }).chat_id ?? opts?.recipientId ?? "-");
  if (c.klass === "rate_limited") {
    if (opts?.admin) {
      await logHealthOnce(opts.admin, "telegram_rate_limited", `${method}:${chatKey}:${minuteStartIso()}`, {
        method,
        purpose: opts?.purpose ?? method,
        recipient: opts?.recipientId ?? null,
        retry_after: c.retryAfterSec,
        error: c.error,
      }, { source: "telegram-send", sinceIso: minuteStartIso() });
    } else {
      console.error("sendTelegramWithResult: rate limited, NOT recorded (no admin client passed)", { method, retry_after: c.retryAfterSec });
    }
    return { outcome, result };
  }
  if (c.klass === "topic_missing" && opts?.topicMissingAction) {
    if (opts?.admin) {
      await logHealth(opts.admin, opts.topicMissingAction, {
        method,
        purpose: opts?.purpose ?? method,
        chat_id: (payload as { chat_id?: unknown }).chat_id ?? null,
        thread_id: (payload as { message_thread_id?: unknown }).message_thread_id ?? null,
        error: c.error,
      }, { source: "telegram-send" });
    } else {
      console.error("sendTelegramWithResult: topic missing, NOT recorded (no admin client passed)", { method, error: c.error });
    }
    return { outcome, result };
  }
  await recordNonDelivery(outcome, method, opts);
  return { outcome, result };
}

// ── Multipart siblings with the finer classes (Daily Tasks PR-7: the Mini App repost, spec §12 / G28) ──────────
// sendTelegramMultipart (above) takes ONE file and the coarse classification (a 429 there is a telegram_send_failed
// row). The Mini App reposts a student's files into a busy group topic, where 429 is flow control, so these two use
// sendTelegramWithResult's classes and recording: rate_limited → one 'telegram_rate_limited' row per minute with
// retry_after (never telegram_send_failed), topic_missing → opts.topicMissingAction, the rest → recordNonDelivery.
// Same token containment: the token lives only in the request URL and never reaches a result or a recorded row.

export type MultipartFile = { field: string; blob: Blob; filename: string };

async function postMultipart(botToken: string, method: string, form: FormData): Promise<{ j: BotApiJson; status: number }> {
  try {
    // No explicit Content-Type: fetch sets multipart/form-data + the boundary from the FormData body.
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", body: form });
    return { j: await resp.json().catch(() => null), status: resp.status };
  } catch {
    return { j: { ok: false, description: "transport_error" }, status: 0 };
  }
}

/** One Bot API method with real file uploads (sendPhoto / sendVideo / sendDocument …), classified like sendTelegramWithResult. */
export async function sendTelegramMultipartWithResult(
  botToken: string,
  method: string,
  fields: Record<string, string | number>,
  files: MultipartFile[],
  opts?: SendResultOpts,
): Promise<{ outcome: SendResultOutcome; result: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const f of files) form.append(f.field, f.blob, f.filename);
  const { j, status } = await postMultipart(botToken, method, form);
  return await resolveWithResult(j, status, method, fields, opts);
}

/** One item of an uploaded album. Telegram groups photo+video together, or documents only (never mixed). */
export type MediaGroupItem = {
  type: "photo" | "video" | "document";
  blob: Blob;
  filename: string;
  caption?: string; // plain text (no parse_mode); Telegram shows the album's caption from its first captioned item
};

export const MEDIA_GROUP_MAX = 10;

/** Why an album cannot be sent as one sendMediaGroup (null = it can). Checked before any network call. */
export function mediaGroupProblem(items: MediaGroupItem[]): string | null {
  if (items.length < 2 || items.length > MEDIA_GROUP_MAX) return "media_group_size";
  if (items.some((i) => !["photo", "video", "document"].includes(i.type))) return "media_group_bad_type";
  const docs = items.filter((i) => i.type === "document").length;
  if (docs > 0 && docs < items.length) return "media_group_mixed_types";
  return null;
}

/**
 * sendMediaGroup with the FILES uploaded in one multipart request (attach://fileN), 2..10 items. `fields` carries
 * chat_id / message_thread_id (and anything else sendMediaGroup takes). On success `result` is Telegram's array of
 * sent Messages, in order. A malformed album (see mediaGroupProblem) is refused without a network call as a
 * terminal content outcome — recorded, because it is a caller bug, never a Telegram one.
 */
export async function sendMediaGroupMultipart(
  botToken: string,
  fields: Record<string, string | number>,
  items: MediaGroupItem[],
  opts?: SendResultOpts,
): Promise<{ outcome: SendResultOutcome; result: any[] | null }> {
  const problem = mediaGroupProblem(items);
  if (problem) {
    const r = await resolveWithResult({ ok: false, description: `Bad Request: ${problem}: wrong type` }, 400, "sendMediaGroup", fields, opts);
    return { outcome: r.outcome, result: null };
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const media = items.map((it, i) => ({
    type: it.type,
    media: `attach://file${i}`,
    ...(it.caption ? { caption: it.caption } : {}),
    ...(it.type === "video" ? { supports_streaming: true } : {}),
  }));
  form.append("media", JSON.stringify(media));
  items.forEach((it, i) => form.append(`file${i}`, it.blob, it.filename));
  const { j, status } = await postMultipart(botToken, "sendMediaGroup", form);
  const r = await resolveWithResult(j, status, "sendMediaGroup", fields, opts);
  return { outcome: r.outcome, result: r.outcome.ok ? (Array.isArray(r.result) ? r.result : []) : null };
}
