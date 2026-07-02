import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isDuplicateError, parseUpdateId } from "./idempotency.ts";

Deno.test("parseUpdateId returns the numeric id", () => {
  assertEquals(parseUpdateId({ update_id: 123, message: {} }), 123);
});

Deno.test("parseUpdateId returns null when absent or non-numeric", () => {
  assertEquals(parseUpdateId({ message: {} }), null);
  assertEquals(parseUpdateId({ update_id: "123" }), null);
  assertEquals(parseUpdateId(null), null);
  assertEquals(parseUpdateId(undefined), null);
  assertEquals(parseUpdateId("nope"), null);
});

Deno.test("isDuplicateError detects a unique violation by code", () => {
  assertEquals(isDuplicateError({ code: "23505" }), true);
});

Deno.test("isDuplicateError detects a unique violation by message", () => {
  assertEquals(isDuplicateError({ message: "duplicate key value violates unique constraint" }), true);
});

Deno.test("isDuplicateError is false for other errors (fail-open)", () => {
  assertEquals(isDuplicateError({ code: "42P01", message: "relation does not exist" }), false);
  assertEquals(isDuplicateError(null), false);
  assertEquals(isDuplicateError(undefined), false);
});
