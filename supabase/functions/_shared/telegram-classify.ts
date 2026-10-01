// Pure send-outcome classification for the broadcast drainer. Same model as notify-badge-award:
// a Telegram response is either accepted (ok), a TERMINAL failure (recipient can't be reached or
// content can't render — never succeeds on retry), or a transient failure (retry, capped).

export function tgResult(
  j: { ok?: boolean; description?: string } | null | undefined,
  httpStatus: number,
): { ok: boolean; error: string | null } {
  if (j?.ok) return { ok: true, error: null };
  return { ok: false, error: String(j?.description || `http_${httpStatus}`).slice(0, 300) };
}

// Recipient-side: the user must act (blocked the bot, never pressed Start → "chat not found", etc.).
export function isRecipientError(err: string | null): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return /bot was blocked|chat not found|user is deactivated|can't initiate|peer_id_invalid|user_is_blocked|have no rights|forbidden|chat_id is empty|bots can't send/.test(e);
}

// Content/validation: same payload will never succeed on retry (caption too long, bad media URL…).
export function isContentError(err: string | null): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return /too long|can't parse|wrong file identifier|wrong type|failed to get http url|wrong remote file|image_process|webpage_curl|media_empty|caption/.test(e);
}

// Terminal = don't retry, mark failed with the reason.
export function isTerminal(err: string | null): boolean {
  return isRecipientError(err) || isContentError(err);
}

// ── Finer send classes (Daily Tasks PR-4, spec G7) ─────────────────────────────────────────────────────────
// Used ONLY by sendTelegramWithResult (telegram-send.ts). tgResult / isTerminal / isRecipientError /
// isContentError above are deliberately UNCHANGED: every existing importer (sendTelegram, the broadcast
// drainer, notify-* senders) keeps its exact classification on its next deploy, so hw_dm_health_stats'
// telegram_send_broken_24h keeps its meaning. A caller opts into the finer classes by using the new sender.
//   ok            accepted
//   not_modified  "message is not modified": an edit to the SAME text/markup. The desired state already
//                 holds, so it is a SUCCESS (never a failure row).
//   rate_limited  HTTP 429 / "Too Many Requests: retry after N". Transient; honour retry_after. Counted as
//                 'telegram_rate_limited', never as telegram_send_failed (it is flow control, not breakage).
//   topic_missing "message thread not found" / TOPIC_CLOSED / TOPIC_DELETED: the forum topic is gone or
//                 closed. Terminal until an admin reopens / re-links it.
//   message_gone  the message to edit is gone or can no longer be edited. Terminal for that message.
//   recipient / content / transient   as isRecipientError / isContentError / everything else.
export type SendClass =
  | "ok" | "not_modified" | "rate_limited" | "topic_missing" | "message_gone" | "recipient" | "content" | "transient";

export function isNotModified(err: string | null): boolean {
  return !!err && /message is not modified/i.test(err);
}

export function isRateLimited(err: string | null, httpStatus = 0): boolean {
  if (httpStatus === 429) return true;
  return !!err && /too many requests|retry after|flood_wait|flood wait/i.test(err);
}

export function isTopicMissing(err: string | null): boolean {
  return !!err && /message thread not found|topic_closed|topic_deleted|topic_id_invalid|thread not found/i.test(err);
}

export function isMessageGone(err: string | null): boolean {
  return !!err && /message to edit not found|message can't be edited|message_id_invalid|message to delete not found/i.test(err);
}

/** Telegram's `parameters.retry_after` (seconds), else the number in "retry after N", else null. Capped at 1 h. */
export function parseRetryAfter(
  j: { description?: string; parameters?: { retry_after?: unknown } } | null | undefined,
): number | null {
  const p = Number(j?.parameters?.retry_after);
  if (Number.isFinite(p) && p > 0) return Math.min(Math.ceil(p), 3600);
  const m = /retry after (\d{1,6})/i.exec(String(j?.description ?? ""));
  if (m) return Math.min(Number(m[1]), 3600);
  return null;
}

/** One class for a Bot API response (see SendClass). Order matters: the specific classes win over the broad ones. */
export function classifySend(
  j: { ok?: boolean; description?: string; parameters?: { retry_after?: unknown } } | null | undefined,
  httpStatus: number,
): { klass: SendClass; error: string | null; retryAfterSec: number | null } {
  const { ok, error } = tgResult(j, httpStatus);
  if (ok) return { klass: "ok", error: null, retryAfterSec: null };
  if (isNotModified(error)) return { klass: "not_modified", error, retryAfterSec: null };
  if (isRateLimited(error, httpStatus)) return { klass: "rate_limited", error, retryAfterSec: parseRetryAfter(j) };
  if (isTopicMissing(error)) return { klass: "topic_missing", error, retryAfterSec: null };
  if (isMessageGone(error)) return { klass: "message_gone", error, retryAfterSec: null };
  if (isRecipientError(error)) return { klass: "recipient", error, retryAfterSec: null };
  if (isContentError(error)) return { klass: "content", error, retryAfterSec: null };
  return { klass: "transient", error, retryAfterSec: null };
}
