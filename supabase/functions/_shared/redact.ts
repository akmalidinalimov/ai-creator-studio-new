// One canonical secret redactor for the edge tier — the mirror of SQL `public.ops_redact_secrets()`
// (migration 20260810130000), so a secret is scrubbed the same way whichever tier touches it.
//
// WHY THIS EXISTS (2026-09-11): Deno's `fetch` throws transport errors whose message embeds the FULL
// request URL — and a Telegram API URL carries the bot token in its path
// (https://api.telegram.org/bot<token>/sendMessage). Any `String(e)` of such an error that gets
// STORED (platform_error_log, a queue row's `error`) or RETURNED to a caller leaks the credential
// that controls the entire bot. That is not hypothetical: 11 rows of platform_error_log held the live
// bot token in plaintext (2026-07-20 → 2026-08-01), written by the webhook's catch-all error logger.
//
// Shapes covered, identical to the SQL function: Telegram bot tokens, Bearer headers, JWTs (Supabase
// keys start `eyJ`), and long hex strings.
//
// This is a LAST line of defence for the log tier, not a licence to pass secrets around: the primary
// fix is that a token-bearing URL never reaches an error string at all (see the webhook's `tgApi` and
// detect-and-nudge's `tgSend`, which rethrow sanitized errors), and the DB triggers added in
// 20260912010000_redact_secrets_in_error_logs.sql are the invariant underneath both.

// NOTE: the `eyJ…` and 40+-hex shapes are deliberately broad, so a legitimate long hash or base64url
// blob written into a redacted column (platform_error_log.context, a queue row's `error`) is replaced
// too. Log a short prefix of a hash rather than the whole thing if you need it back for debugging.
const SECRET_RE =
  /(bot[0-9]+:[A-Za-z0-9_-]{20,}|[Bb]earer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*|[A-Fa-f0-9]{40,})/g;

/**
 * Stringify anything (Error, object, null) and strip every secret shape from the result.
 * An Error collapses to its message, matching what the error-logging call sites already stored.
 */
export function redactSecrets(input: unknown): string {
  const s = input instanceof Error ? (input.message || String(input)) : String(input ?? "");
  return s.replace(SECRET_RE, "<redacted>");
}

/**
 * Same, for a structure that must stay valid JSON (a jsonb column). `<redacted>` is a legal JSON
 * string body, so the round-trip cannot produce invalid JSON; an unserialisable input degrades to {}
 * rather than throwing inside an error-logging path that must never throw.
 */
export function redactJson<T>(value: T): T | Record<string, never> {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value ?? {}))) as T;
  } catch {
    return {};
  }
}
