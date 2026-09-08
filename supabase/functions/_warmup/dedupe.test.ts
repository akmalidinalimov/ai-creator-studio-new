import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ledgerDedupeKey, sendDedupeKey, sha256Hex } from "./dedupe.ts";

Deno.test("same award → same key (this is what makes a replay a no-op)", async () => {
  const a = await ledgerDedupeKey(111, "react:-100:5", "reaction", "points-basic");
  const b = await ledgerDedupeKey(111, "react:-100:5", "reaction", "points-basic");
  assertEquals(a, b);
  assertMatch(a, /^[0-9a-f]{64}$/);
});

Deno.test("key matches the exact format SPEC §3 mandates", async () => {
  assertEquals(
    await ledgerDedupeKey(111, "react:-100:5", "reaction", "points-basic"),
    await sha256Hex("111|react:-100:5|reaction|points-basic"),
  );
});

Deno.test("all four fields participate — none may be dropped", async () => {
  const keys = new Set([
    await ledgerDedupeKey(111, "react:-100:5", "reaction", "points-basic"),
    await ledgerDedupeKey(112, "react:-100:5", "reaction", "points-basic"),   // other person
    await ledgerDedupeKey(111, "react:-100:6", "reaction", "points-basic"),   // other message
    await ledgerDedupeKey(111, "react:-100:5", "comment", "points-basic"),    // other action
    await ledgerDedupeKey(111, "react:-100:5", "reaction", "streaks"),        // other plugin
  ]);
  assertEquals(keys.size, 5);
});

// Pins the documented limit so it stays a known trade-off rather than becoming a surprise. Safe
// while every sourceRef and action is engine-generated; see the note at the top of dedupe.ts.
Deno.test("KNOWN LIMIT: an unescaped pipe inside a value collides", async () => {
  assertEquals(
    await ledgerDedupeKey(1, "a|b", "c", "p"),
    await ledgerDedupeKey(1, "a", "b|c", "p"),
  );
});

Deno.test("send keys are namespaced away from ledger keys", async () => {
  const ledger = await ledgerDedupeKey(111, "day1.midday", "midday", "scheduler");
  const send = await sendDedupeKey(111, "day1.midday", "midday", 1);
  assertEquals(send === ledger, false);
  assertEquals(send, await sendDedupeKey(111, "day1.midday", "midday", 1));
});

Deno.test("send key distinguishes recipient, copy, slot and day", async () => {
  const base = await sendDedupeKey(111, "day1.midday", "midday", 1);
  const keys = new Set([
    base,
    await sendDedupeKey(222, "day1.midday", "midday", 1),
    await sendDedupeKey(111, "day2.midday", "midday", 1),
    await sendDedupeKey(111, "day1.midday", "evening", 1),
    await sendDedupeKey(111, "day1.midday", "midday", 2),
  ]);
  assertEquals(keys.size, 5);
});
