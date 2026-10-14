import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clip, deepWellFormed, wellFormed } from "./text-safe.ts";
import { renderTqDigest, renderTqList, type TqRow } from "./teacher-questions.ts";

// The real name that broke 48 curator reminders on 2026-10-14: Mathematical Bold letters, two UTF-16 units each.
const FANCY = "𝐎𝐌𝐎𝐍𝐈𝐋𝐋𝐎 𝐙𝐈𝐘𝐎 𝐁𝐄𝐔";
const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const utf8RoundTrips = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;

Deno.test("the bug: .slice(0, 24) cuts a Mathematical Bold letter in half — clip never does", () => {
  assert(!isWellFormed(FANCY.slice(0, 24)), "reproduces the broken cut");
  for (let n = 0; n <= FANCY.length + 2; n++) {
    const c = clip(FANCY, n);
    assert(isWellFormed(c) && utf8RoundTrips(c), `clip at ${n}`);
    assert(c.length <= n);
  }
  assertEquals(clip("Ali", 24), "Ali");
  assertEquals(clip("🌸Sitora🌸", 1), "");                 // never half an emoji
  assertEquals(clip("🌸Sitora🌸", 2), "🌸");
});

Deno.test("wellFormed / deepWellFormed drop lone halves everywhere in a payload, keep everything else", () => {
  const broken = FANCY.slice(0, 24);
  assert(isWellFormed(wellFormed(broken)));
  const payload = { chat_id: -100, text: broken, reply_markup: { inline_keyboard: [[{ text: broken, callback_data: "tq:o:147" }]] } };
  const fixed = deepWellFormed(payload);
  assertEquals(fixed.chat_id, -100);
  assertEquals(fixed.reply_markup.inline_keyboard[0][0].callback_data, "tq:o:147");
  assert(isWellFormed(fixed.text) && isWellFormed(fixed.reply_markup.inline_keyboard[0][0].text));
  assertEquals(wellFormed("🌸 ok"), "🌸 ok");
});

Deno.test("curator reminder buttons stay valid for a fancy-letter name (the failing message)", () => {
  const now = Date.parse("2026-10-14T11:00:00Z");
  const row = {
    id: 147, group_id: "g1", chat_id: -1004440955972, thread_id: 2, tg_user_id: 1, student_id: "s1", student_name: FANCY,
    student_username: null, first_message_id: 10, message_ids: [10], text: "savol?", media: [], peer_reply_ids: [],
    asked_at: "2026-10-14T07:00:00Z", status: "open", reminder_count: 1,
  } as unknown as TqRow;
  const kbs = [renderTqDigest([row], now, { g1: "AC CHALLENGE | 1-GURUH" }).keyboard, renderTqList("o", [row], 0, now, { g1: "AC CHALLENGE | 1-GURUH" }, null).keyboard];
  for (const kb of kbs) {
    for (const b of kb.inline_keyboard.flat()) assert(isWellFormed(b.text) && utf8RoundTrips(b.text), b.text);
  }
});
