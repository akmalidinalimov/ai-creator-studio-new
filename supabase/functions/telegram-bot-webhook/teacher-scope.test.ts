// Tests for the teacher bot-scope check. Run: deno test supabase/functions/telegram-bot-webhook/teacher-scope.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { taughtScope } from "./teacher-scope.ts";

const G1 = "6eea7030-6b68-4f00-8e0f-9d07b193e0dd";
const G2 = "22222222-2222-2222-2222-222222222222";
const mine = [{ id: G1, name: "G1" }];

Deno.test("a group the teacher teaches is kept", () => {
  assertEquals(taughtScope(G1, mine), G1);
});

Deno.test("a foreign group (forged tap / self-PATCH) falls back to all own groups", () => {
  assertEquals(taughtScope(G2, mine), null);
});

Deno.test("a stale group after a reassignment falls back", () => {
  assertEquals(taughtScope(G1, []), null);
});

Deno.test("no stored scope stays no scope", () => {
  assertEquals(taughtScope(null, mine), null);
  assertEquals(taughtScope(undefined, mine), null);
  assertEquals(taughtScope("", mine), null);
});

Deno.test("an exact id match only (no prefix or case games)", () => {
  assertEquals(taughtScope(G1.slice(0, 8), mine), null);
  assertEquals(taughtScope(G1.toUpperCase(), mine), null);
});
