// Tests for the shared secret redactor. Run: deno test supabase/functions/_shared/redact.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { redactJson, redactSecrets } from "./redact.ts";

// Token-SHAPED fixtures only — never a real credential in a test file.
const FAKE_TOKEN = "bot123456789:AAHfakefakefakefakefakefake_0123456789";

Deno.test("redactSecrets strips the bot token from a Deno transport error", () => {
  // The exact shape that put the live token into platform_error_log 11 times.
  const e = new Error(
    `error sending request for url (https://api.telegram.org/${FAKE_TOKEN}/sendMessage): connection reset`,
  );
  const out = redactSecrets(e);
  assertEquals(out.includes("123456789:AAH"), false);
  assertStringIncludes(out, "<redacted>");
  assertStringIncludes(out, "connection reset"); // the diagnostic must survive the redaction
});

Deno.test("redactSecrets strips bearer headers, JWTs and long hex", () => {
  assertEquals(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123").includes("abcdefghij"), false);
  assertEquals(
    redactSecrets("key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig").includes("eyJhbGciOi"),
    false,
  );
  assertEquals(redactSecrets("hash " + "a".repeat(40)).includes("a".repeat(40)), false);
});

Deno.test("redactSecrets leaves ordinary text and short ids alone", () => {
  assertEquals(redactSecrets("Connection reset by peer while grading homework"), "Connection reset by peer while grading homework");
  assertEquals(redactSecrets("submission 7f3a2b1c"), "submission 7f3a2b1c");
  assertEquals(redactSecrets(null), "");
});

Deno.test("redactJson scrubs nested values and stays valid JSON", () => {
  const out = redactJson({
    url: `https://api.telegram.org/${FAKE_TOKEN}/sendVoice`,
    submission_id: "abc-123",
  }) as Record<string, string>;
  assertEquals(out.url.includes("123456789:AAH"), false);
  assertStringIncludes(out.url, "<redacted>");
  assertEquals(out.submission_id, "abc-123");
});

Deno.test("redactJson degrades to {} instead of throwing (logging must never throw)", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertEquals(redactJson(circular), {});
});
