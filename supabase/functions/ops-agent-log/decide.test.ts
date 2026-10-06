import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldSendPrCard } from "./decide.ts";
import { opsApproveKeyboard, opsPrCardText, opsPrNumber } from "../_shared/ops-card.ts";

Deno.test("shouldSendPrCard: first time a PR is logged only; a failed lookup still sends", () => {
  assertEquals(shouldSendPrCard("pr", 281, 0), true);
  assertEquals(shouldSendPrCard("pr", 281, 2), false, "an earlier run already carded it");
  assertEquals(shouldSendPrCard("pr", 281, null), true, "unknown → send (a duplicate is harmless)");
  assertEquals(shouldSendPrCard("issue", 12, 0), false);
  assertEquals(shouldSendPrCard("none", null, 0), false);
  assertEquals(shouldSendPrCard("pr", null, 0), false);
});

Deno.test("opsPrNumber accepts only a plain PR number", () => {
  assertEquals(opsPrNumber("281"), 281);
  assertEquals(opsPrNumber(" 7 "), 7);
  assertEquals(opsPrNumber(42), 42);
  assertEquals(opsPrNumber("281abc"), null);
  assertEquals(opsPrNumber("0"), null);
  assertEquals(opsPrNumber("1234567"), null);
  assertEquals(opsPrNumber(""), null);
});

Deno.test("the card: escaped problem, the ops:a / ops:reject keyboard (≤ 64 bytes), the PR link", () => {
  const t = opsPrCardText(281, "group <b>x</b> & y");
  assertStringIncludes(t, "Ops-agent PR ochdi: #281");
  assertStringIncludes(t, "group &lt;b&gt;x&lt;/b&gt; &amp; y");
  const kb = opsApproveKeyboard(281);
  assertEquals(kb.inline_keyboard[0].map((b: any) => b.callback_data), ["ops:a:281", "ops:reject:281"]);
  assert(kb.inline_keyboard[0].every((b: any) => new TextEncoder().encode(b.callback_data).length <= 64));
  assertStringIncludes((kb.inline_keyboard[1][0] as { url: string }).url, "/pull/281");
  assert(opsPrCardText(1, "x".repeat(5000)).length < 4096);
});
