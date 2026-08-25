import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isContentError, isRecipientError, isTerminal, tgResult } from "./telegram-classify.ts";

Deno.test("tgResult: accepted", () => {
  assertEquals(tgResult({ ok: true }, 200), { ok: true, error: null });
});

Deno.test("tgResult: telegram description carried", () => {
  assertEquals(
    tgResult({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403),
    { ok: false, error: "Forbidden: bot was blocked by the user" },
  );
});

Deno.test("tgResult: http fallback when no description", () => {
  assertEquals(tgResult({}, 502), { ok: false, error: "http_502" });
  assertEquals(tgResult(null, 500), { ok: false, error: "http_500" });
});

Deno.test("terminal: recipient blocked the bot", () => {
  assertEquals(isRecipientError("Forbidden: bot was blocked by the user"), true);
  assertEquals(isTerminal("Forbidden: bot was blocked by the user"), true);
});

Deno.test("terminal: never pressed Start (chat not found)", () => {
  assertEquals(isRecipientError("Bad Request: chat not found"), true);
  assertEquals(isTerminal("Bad Request: chat not found"), true);
});

Deno.test("terminal: content too long", () => {
  assertEquals(isContentError("Bad Request: message caption is too long"), true);
  assertEquals(isTerminal("Bad Request: message caption is too long"), true);
});

Deno.test("terminal: bad image URL", () => {
  assertEquals(isContentError("Bad Request: failed to get HTTP URL content"), true);
  assertEquals(isTerminal("Bad Request: failed to get HTTP URL content"), true);
});

Deno.test("transient: rate limit and network are NOT terminal", () => {
  assertEquals(isTerminal("http_429"), false);
  assertEquals(isTerminal("network:connection reset"), false);
  assertEquals(isTerminal("http_502"), false);
});

Deno.test("null error is not terminal", () => {
  assertEquals(isTerminal(null), false);
  assertEquals(isRecipientError(null), false);
  assertEquals(isContentError(null), false);
});

// ── Reliability-hardening P2-5: pinned Telegram error-string contract ─────────────────────────────
// The classifier is a regex over Telegram's `description` strings — so if a future edit drops a token,
// or Telegram rewords an error into a phrasing our regex no longer matches, classification drifts
// SILENTLY: a permanent recipient/content failure would be treated as transient and retried forever,
// and a mass regression (see P1-3) would hide inside the "expected recipient reach" it's excluded from.
// Each row below is a VERBATIM Bot API `description`; the booleans are the contract this test locks in.
// A regex change that reclassifies any pinned string fails CI, forcing a deliberate decision.

const RECIPIENT_STRINGS = [
  "Forbidden: bot was blocked by the user",
  "Bad Request: chat not found",
  "Forbidden: user is deactivated",
  "Forbidden: bot can't initiate conversation with a user",
  "Bad Request: PEER_ID_INVALID",
  "Forbidden: bot was kicked from the supergroup chat",
  "Bad Request: have no rights to send a message",
  "Bad Request: chat_id is empty",
  "Forbidden: bots can't send messages to bots",
  "USER_IS_BLOCKED",
];

const CONTENT_STRINGS = [
  "Bad Request: message is too long",
  "Bad Request: message caption is too long",
  "Bad Request: can't parse entities: Unsupported start tag",
  "Bad Request: wrong file identifier/HTTP URL specified",
  "Bad Request: failed to get HTTP URL content",
  "Bad Request: wrong type of the web page content",
  "Bad Request: IMAGE_PROCESS_FAILED",
  "Bad Request: WEBPAGE_CURL_FAILED",
  "Bad Request: MEDIA_EMPTY",
  "Bad Request: wrong remote file identifier specified",
];

// Retryable — must classify as neither terminal class, so the drainer keeps retrying (rate limits,
// 5xx, transport blips). If any of these ever reads as terminal, real deliveries get dropped.
const TRANSIENT_STRINGS = [
  "Too Many Requests: retry after 30",
  "http_429",
  "http_500",
  "http_502",
  "http_504",
  "transport_error",
  "Internal Server Error",
];

for (const s of RECIPIENT_STRINGS) {
  Deno.test(`pinned recipient (terminal): ${s}`, () => {
    assertEquals(isRecipientError(s), true, `expected RECIPIENT-class: ${s}`);
    assertEquals(isTerminal(s), true, `expected TERMINAL: ${s}`);
  });
}

for (const s of CONTENT_STRINGS) {
  Deno.test(`pinned content (terminal): ${s}`, () => {
    assertEquals(isContentError(s), true, `expected CONTENT-class: ${s}`);
    assertEquals(isTerminal(s), true, `expected TERMINAL: ${s}`);
  });
}

for (const s of TRANSIENT_STRINGS) {
  Deno.test(`pinned transient (retryable, NOT terminal): ${s}`, () => {
    assertEquals(isRecipientError(s), false, `should NOT be recipient-class: ${s}`);
    assertEquals(isContentError(s), false, `should NOT be content-class: ${s}`);
    assertEquals(isTerminal(s), false, `should NOT be terminal: ${s}`);
  });
}
