import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isButtonRejection, isContentError, isGlobalFailure, isRecipientError, isTerminal, tgResult } from "./telegram-classify.ts";

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
  // sendVoice to a user whose privacy settings refuse voice messages. The student's own choice, so it is
  // expected reach: the voice-feedback detectors (grade_delivery_watchdog_fast / hw_dm_health_stats
  // voice_dm_failed_24h, 20260926235000) exclude it only because this reads as recipient-class.
  "Bad Request: VOICE_MESSAGES_FORBIDDEN",
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

// ── Incident 2026-10-01 (fix/telegram-recipient-class): the per-recipient descriptions the fan-out found ──────────
// misclassified as transient / "Telegram refuses our button". Every string is VERBATIM: the first one is the live
// row that froze the ☰ sweep (admin_actions 'miniapp_button_rejected' 2026-10-01 04:02 UTC, setChatMenuButton 400,
// for a member whose 38 daily reminders had all failed with "chat not found" / "can't initiate" — the same person,
// worded per method). The rest are their per-user / per-chat siblings (getChatMember, setChatMenuButton, group posts).
const RECIPIENT_2026_10_01 = [
  "Bad Request: user not found",
  "Bad Request: USER_ID_INVALID",
  "Bad Request: invalid user_id specified",
  "Bad Request: PARTICIPANT_ID_INVALID",
  "Bad Request: member not found",
  "Bad Request: not enough rights to send text messages to the chat",
  "Bad Request: not enough rights to send photos to the chat",
  "Bad Request: group chat was upgraded to a supergroup chat",
];

for (const s of RECIPIENT_2026_10_01) {
  Deno.test(`pinned recipient (2026-10-01, terminal): ${s}`, () => {
    assertEquals(isRecipientError(s), true, `expected RECIPIENT-class: ${s}`);
    assertEquals(isTerminal(s), true, `expected TERMINAL: ${s}`);
    assertEquals(isButtonRejection({ ok: false, status: 400, error: s }), false, `a per-recipient 400 is never OUR button: ${s}`);
    assertEquals(isGlobalFailure(400, s), false, `a per-recipient 400 is never bot-wide: ${s}`);
  });
}

// Content the fan-out found falling through to transient (and so retried, and read as a button refusal).
const CONTENT_2026_10_01 = [
  "Bad Request: text must be encoded in UTF-8", // live: teacher_weekly_digest 2026-09-14 (a lone surrogate)
  "Bad Request: BUTTON_TYPE_INVALID",
  "Bad Request: BUTTON_URL_INVALID",
  "Bad Request: BUTTON_DATA_INVALID",
  "Bad Request: WEBAPP_URL_INVALID",
  "Bad Request: inline keyboard button Web App URL 'http://x' is invalid: Only HTTPS links are allowed",
];

for (const s of CONTENT_2026_10_01) {
  Deno.test(`pinned content (2026-10-01, terminal): ${s}`, () => {
    assertEquals(isContentError(s), true, `expected CONTENT-class: ${s}`);
    assertEquals(isTerminal(s), true, `expected TERMINAL: ${s}`);
  });
}

// The other direction — what must NEVER be swallowed as "the recipient's problem" (expected reach, no alarm):
// a refusal of OUR button / web app URL, our content, and a bot-wide failure. Reading any of these as recipient
// would hide a real breakage inside the ~70% unreachable-student noise.
const NEVER_RECIPIENT = [
  "Bad Request: BUTTON_TYPE_INVALID",
  "Bad Request: BUTTON_URL_INVALID",
  "Bad Request: WEBAPP_URL_INVALID",
  "Bad Request: inline keyboard button Web App URL 'http://x' is invalid: Only HTTPS links are allowed",
  "Bad Request: text must be encoded in UTF-8",
  "Bad Request: can't parse entities: Unsupported start tag",
  "Bad Request: message is too long",
  "Unauthorized",
  "Not Found",
  "http_401",
  "Too Many Requests: retry after 30",
  "transport_error",
];

for (const s of NEVER_RECIPIENT) {
  Deno.test(`never recipient-class (would hide a real breakage): ${s}`, () => {
    assertEquals(isRecipientError(s), false, `must NOT be recipient-class: ${s}`);
  });
}

Deno.test("isButtonRejection: a POSITIVE 400 about a button / web app only", () => {
  const r = (error: string | null, status = 400, ok = false) => ({ ok, status, error });
  for (const s of ["Bad Request: BUTTON_TYPE_INVALID", "Bad Request: BUTTON_URL_INVALID", "Bad Request: WEBAPP_URL_INVALID",
    "Bad Request: inline keyboard button Web App URL 'x' is invalid"]) {
    assertEquals(isButtonRejection(r(s)), true, s);
  }
  for (const s of ["Bad Request: user not found", "Bad Request: chat not found", "Bad Request: can't parse entities",
    "Bad Request: message is too long", "Bad Request: text must be encoded in UTF-8", "Bad Request: something new",
    "Bad Request: message to edit not found", null]) {
    assertEquals(isButtonRejection(r(s)), false, String(s));
  }
  assertEquals(isButtonRejection(r("Bad Request: BUTTON_TYPE_INVALID", 200, true)), false, "accepted");
  assertEquals(isButtonRejection(r("BUTTON_TYPE_INVALID", 429)), false, "only a 400");
});

Deno.test("isGlobalFailure: the bot itself (401 / 404), never one recipient or one payload", () => {
  assertEquals(isGlobalFailure(401, "Unauthorized"), true);
  assertEquals(isGlobalFailure(404, "Not Found"), true);
  assertEquals(isGlobalFailure(0, "Unauthorized"), true);
  assertEquals(isGlobalFailure(400, "Bad Request: chat not found"), false);
  assertEquals(isGlobalFailure(400, "Bad Request: user not found"), false);
  assertEquals(isGlobalFailure(403, "Forbidden: bot was blocked by the user"), false);
  assertEquals(isGlobalFailure(429, "Too Many Requests: retry after 3"), false);
  assertEquals(isGlobalFailure(0, "transport_error"), false);
  // isTerminal deliberately unchanged for it: a queued message goes out once the token is fixed
  assertEquals(isTerminal("Unauthorized"), false);
});

// Every description production recorded in the 90 days to 2026-10-01 (admin_actions telegram_send_failed /
// badge_dm_failed / miniapp_button_rejected, broadcast_deliveries, badge_award_queue, nudge_log), with the class
// it MUST have. A reword by Telegram or a regex edit that moves any of them fails here.
const PROD_90D: Array<[string, "recipient" | "content" | "transient"]> = [
  ["Bad Request: chat not found", "recipient"], // 1998 rows
  ["Forbidden: bot was blocked by the user", "recipient"], // 1989
  ["Forbidden: user is deactivated", "recipient"], // 209
  ["Forbidden: bot can't initiate conversation with a user", "recipient"], // 26
  ["Bad Request: failed to get HTTP URL content", "content"], // 13 (badges)
  ["Bad Request: text must be encoded in UTF-8", "content"], // 2 — was transient
  ["Bad Request: user not found", "recipient"], // 1 — was transient → froze the ☰ sweep
  ["transport_error", "transient"], // 1
];

for (const [s, want] of PROD_90D) {
  Deno.test(`prod description (90 d) → ${want}: ${s}`, () => {
    const got = isRecipientError(s) ? "recipient" : isContentError(s) ? "content" : "transient";
    assertEquals(got, want, s);
  });
}
