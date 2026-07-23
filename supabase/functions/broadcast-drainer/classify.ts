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
