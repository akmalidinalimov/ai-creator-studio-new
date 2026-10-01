// Daily Tasks PR-4 (spec G7): the finer send classes that ONLY sendTelegramWithResult uses.
// Run: deno test supabase/functions/_shared/telegram-classify-classes.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySend, isMessageGone, isNotModified, isRateLimited, isTerminal, isTopicMissing, parseRetryAfter,
} from "./telegram-classify.ts";

Deno.test("classifySend: accepted → ok", () => {
  assertEquals(classifySend({ ok: true }, 200), { klass: "ok", error: null, retryAfterSec: null });
});

Deno.test("classifySend: 'message is not modified' is its own (success) class, never transient", () => {
  const r = classifySend({
    ok: false,
    description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
  }, 400);
  assertEquals(r.klass, "not_modified");
  assertEquals(isNotModified(r.error), true);
});

Deno.test("classifySend: 429 → rate_limited with retry_after from parameters (preferred) or the description", () => {
  const a = classifySend({ ok: false, description: "Too Many Requests: retry after 35", parameters: { retry_after: 35 } }, 429);
  assertEquals(a.klass, "rate_limited");
  assertEquals(a.retryAfterSec, 35);
  const b = classifySend({ ok: false, description: "Too Many Requests: retry after 7" }, 429);
  assertEquals(b.retryAfterSec, 7);
  const c = classifySend({ ok: false }, 429); // the HTTP status alone
  assertEquals(c.klass, "rate_limited");
  assertEquals(c.retryAfterSec, null);
  assertEquals(isRateLimited(null, 429), true);
  assertEquals(parseRetryAfter({ parameters: { retry_after: 99999 } }), 3600); // capped at an hour
  assertEquals(parseRetryAfter({ description: "no number here" }), null);
});

Deno.test("classifySend: a missing / closed forum topic is terminal topic_missing (checked before recipient/content)", () => {
  for (const d of ["Bad Request: message thread not found", "Bad Request: TOPIC_CLOSED", "Bad Request: TOPIC_DELETED"]) {
    assertEquals(classifySend({ ok: false, description: d }, 400).klass, "topic_missing");
    assertEquals(isTopicMissing(d), true);
  }
});

Deno.test("classifySend: an edit whose message is gone → message_gone", () => {
  assertEquals(classifySend({ ok: false, description: "Bad Request: message to edit not found" }, 400).klass, "message_gone");
  assertEquals(isMessageGone("Bad Request: message can't be edited"), true);
});

Deno.test("classifySend: recipient / content / transient keep today's meaning", () => {
  assertEquals(classifySend({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403).klass, "recipient");
  assertEquals(classifySend({ ok: false, description: "Bad Request: can't parse entities" }, 400).klass, "content");
  assertEquals(classifySend(null, 502).klass, "transient");
  assertEquals(classifySend({ ok: false, description: "transport_error" }, 0).klass, "transient");
});

Deno.test("2026-10-01: a per-user / per-chat refusal is 'recipient' (terminal, skipped), never 'transient' (retried)", () => {
  // sendTelegramWithResult callers (Daily Tasks worker DMs / receipts / posts, submit-daily-task) retried these up to
  // 5x, each try a telegram_send_failed row counted as "Telegram broken".
  for (const d of [
    "Bad Request: user not found",
    "Bad Request: USER_ID_INVALID",
    "Bad Request: PARTICIPANT_ID_INVALID",
    "Bad Request: not enough rights to send text messages to the chat",
    "Bad Request: group chat was upgraded to a supergroup chat",
  ]) {
    assertEquals(classifySend({ ok: false, description: d }, 400).klass, "recipient", d);
  }
  // our payload: content (terminal), not transient
  assertEquals(classifySend({ ok: false, description: "Bad Request: text must be encoded in UTF-8" }, 400).klass, "content");
  assertEquals(classifySend({ ok: false, description: "Bad Request: BUTTON_TYPE_INVALID" }, 400).klass, "content");
  // the bot itself: still transient here (a queued item goes out once the token is fixed) — loud as non-recipient
  assertEquals(classifySend({ ok: false, description: "Unauthorized" }, 401).klass, "transient");
});

Deno.test("the old helpers are unchanged: not_modified / 429 / topic errors stay non-terminal for sendTelegram importers", () => {
  assertEquals(isTerminal("Bad Request: message is not modified"), false);
  assertEquals(isTerminal("Too Many Requests: retry after 5"), false);
  assertEquals(isTerminal("Bad Request: message thread not found"), false);
});
