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

// Recipient-side: ONE user (or, for a group, that chat's admins) must act — blocked the bot, never pressed Start
// ("chat not found"), deleted, unknown to the bot, or the bot lost its rights in that chat. Per recipient, never
// global: a failure here says nothing about our payload or the bot, so it is the reach metric, not an alarm.
//
// Incident 2026-10-01 (fix/telegram-recipient-class): "Bad Request: user not found" — what setChatMenuButton /
// getChatMember answer for a user the bot cannot resolve, where sendMessage says "chat not found" — was missing,
// so it read as a non-recipient 400. menu-button.ts then took it for "Telegram refuses our Mini App button", the ☰
// sweep stopped on that one member every 30 minutes and never finished (95 of 166), and every such row counted as
// "Telegram is broken" in hw_dm_health_stats.telegram_send_broken_24h. The per-user / per-chat siblings found by
// the fan-out are listed with it; each is pinned verbatim in telegram-classify.test.ts.
const RECIPIENT_RE = new RegExp(
  [
    "bot was blocked", "chat not found", "user is deactivated", "can't initiate", "peer_id_invalid", "user_is_blocked",
    "have no rights", "forbidden", "chat_id is empty", "bots can't send",
    // per USER (2026-10-01): the bot cannot resolve this user / this user is not in the chat
    "user not found", "user_id_invalid", "invalid user_id", "participant_id_invalid", "member not found",
    // per CHAT (2026-10-01): an admin of that chat must restore the bot's rights / the chat moved to a supergroup id.
    // Already 'expected' in the pg_net classifier (platform_settings.ops_http_watchdog.tg_expected_regex).
    "not enough rights", "group chat was upgraded",
  ].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

export function isRecipientError(err: string | null): boolean {
  if (!err) return false;
  return RECIPIENT_RE.test(err.toLowerCase());
}

// Content/validation: same payload will never succeed on retry (caption too long, bad media URL…). Since
// 2026-10-01 also invalid UTF-16 in the text (a lone surrogate left by a .slice()) and a button Telegram refuses
// (BUTTON_TYPE_INVALID / BUTTON_URL_INVALID / BUTTON_DATA_INVALID / "…Web App URL … is invalid") — both used to
// fall through to transient and be retried.
export function isContentError(err: string | null): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return /too long|can't parse|wrong file identifier|wrong type|failed to get http url|wrong remote file|image_process|webpage_curl|media_empty|caption|must be encoded in utf-8|button|web ?app/.test(e);
}

/**
 * Telegram refused a BUTTON in our payload (BUTTON_TYPE_INVALID, BUTTON_URL_INVALID, WEBAPP_URL_INVALID, "inline
 * keyboard button Web App URL … is invalid") — a POSITIVE match on a 400 about a button, never a recipient error.
 * This is the only 400 a resend without the web_app button (or a fixed URL / label) can cure, and the only one that
 * may raise a Mini App button alarm. It replaces the old negative rule "any non-recipient 400 on a message with a
 * web_app button", which read every unlisted per-user 400 ("user not found") and every content 400 ("can't parse
 * entities") as "Telegram refuses our button".
 */
export function isButtonRejection(r: { ok: boolean; status: number; error: string | null }): boolean {
  if (r.ok || r.status !== 400 || !r.error) return false;
  if (isRecipientError(r.error)) return false;
  return /button|web ?app/i.test(r.error);
}

/**
 * A failure of the BOT, not of one recipient or one payload: 401 Unauthorized (the token was revoked or rotated)
 * or 404 Not Found (malformed token / unknown method). Every call fails until a human fixes it, so a loop over
 * recipients must stop instead of burning through everyone. isTerminal is deliberately NOT changed for it: a
 * queued message will go out once the token is fixed, and as a non-recipient failure it already counts as
 * "Telegram broken" in telegram_send_broken_24h, which is the loud signal it deserves.
 */
export function isGlobalFailure(status: number, err: string | null): boolean {
  if (status === 401 || status === 404) return true;
  return !!err && /^(unauthorized|not found)$/i.test(err.trim());
}

// Terminal = don't retry, mark failed with the reason.
export function isTerminal(err: string | null): boolean {
  return isRecipientError(err) || isContentError(err);
}

// ── Finer send classes (Daily Tasks PR-4, spec G7) ─────────────────────────────────────────────────────────
// Used ONLY by sendTelegramWithResult (telegram-send.ts). PR-4 left tgResult / isTerminal / isRecipientError /
// isContentError untouched; 2026-10-01 widened isRecipientError / isContentError with the descriptions the
// fan-out found misclassified (see above). Their MEANING is unchanged — recipient = one recipient must act,
// content = this payload never renders — so telegram_send_broken_24h still counts exactly the non-recipient
// failures, now without per-user errors that were never "Telegram broken". A caller opts into the finer classes
// by using the new sender.
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
