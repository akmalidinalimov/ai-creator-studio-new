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
