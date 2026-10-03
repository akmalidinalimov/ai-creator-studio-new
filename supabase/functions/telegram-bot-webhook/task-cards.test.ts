import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dayLabel, parseTaskCardCb, refusalText, renderTaskCard, type TaskCard, weekCb } from "./task-cards.ts";

const card = (p: Partial<TaskCard> = {}): TaskCard => ({
  ok: true,
  task_id: 31,
  date: "2026-10-05",
  weekday: 1,
  title: "ChatGPT'ni o‘zingizga moslang",
  body: "Settings → Personalization bo‘limiga o‘zingiz haqingizda yozing.",
  submit_hint: "Topshirish: 2 ta skrinshot",
  type: "general",
  points: 5,
  minutes: 10,
  status: "draft",
  past: false,
  posted: false,
  ...p,
});

Deno.test("parseTaskCardCb: only our four shapes, and a task id must be a real number", () => {
  assertEquals(parseTaskCardCb("dtt:a:31"), { kind: "approve", taskId: 31 });
  assertEquals(parseTaskCardCb("dtt:c:7"), { kind: "change", taskId: 7 });
  assertEquals(parseTaskCardCb("dtt:x:7"), { kind: "cancel", taskId: 7 });
  assertEquals(parseTaskCardCb("dtt:l:20261005"), { kind: "list", week: "2026-10-05" });
  // not ours / malformed / hostile
  for (const bad of [
    "dtt:a:0", "dtt:a:-1", "dtt:a:", "dtt:a:abc", "dtt:z:1", "dtt:l:2026100", "dtt:l:oct",
    "dtw:a:20261005", "dt:m:1:2", "", "dtt:a:1 ", "dtt:a:1;drop", "dtt:a:99999999999999999999",
  ]) {
    assertEquals(parseTaskCardCb(bad), null, bad);
  }
});

Deno.test("every callback_data stays far inside Telegram's 64-byte limit", () => {
  const v = renderTaskCard(card({ task_id: 9007199254740991 }), "uz");
  for (const row of v.keyboard.inline_keyboard) {
    for (const b of row) {
      assert(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
    }
  }
  assertEquals(new TextEncoder().encode(weekCb("2026-10-05")).length, 14);
});

Deno.test("a draft dated today or later: both buttons, and the card states it is not posted yet", () => {
  const v = renderTaskCard(card(), "uz");
  assertEquals(v.keyboard.inline_keyboard[0].map((b) => b.callback_data), ["dtt:a:31", "dtt:c:31"]);
  assert(v.text.includes("5-oktabr (dushanba)"), v.text);
  assert(v.text.includes("📝 umumiy"));
  assert(v.text.includes("⭐️ 5 ball"));
  assert(v.text.includes("QORALAMA"), v.text);
  assert(v.text.includes("Topshirish: 2 ta skrinshot"));
});

Deno.test("an APPROVED task keeps ✏️ but never ✅ (the RPC would refuse a second approval)", () => {
  const v = renderTaskCard(card({ status: "approved" }), "uz");
  assertEquals(v.keyboard.inline_keyboard[0].map((b) => b.callback_data), ["dtt:c:31"]);
  assert(v.text.includes("✅ tasdiqlangan"));
});

Deno.test("a PAST day never offers ✅ — an approved-but-never-posted day breaks every student's streak", () => {
  const v = renderTaskCard(card({ past: true }), "uz");
  assertEquals(v.keyboard.inline_keyboard[0].map((b) => b.callback_data), ["dtt:c:31"]);
  assert(v.text.includes("⌛ o‘tgan kun"), v.text);
});

Deno.test("a CANCELLED task offers nothing", () => {
  const v = renderTaskCard(card({ status: "cancelled" }), "uz");
  assertEquals(v.keyboard.inline_keyboard, []);
});

Deno.test("editing mode: only ↩️, and the prompt says what will and will not change", () => {
  const v = renderTaskCard(card(), "uz", { editing: true });
  assertEquals(v.keyboard.inline_keyboard[0].map((b) => b.callback_data), ["dtt:x:31"]);
  assert(v.text.includes("Yangi matnni shu yerga yuboring"), v.text);
  assert(v.text.includes("sarlavha, tur, ball va topshirish talabi o‘zgarmaydi"), v.text);
});

Deno.test("the body is HTML-escaped, so a task text can never break the message or inject markup", () => {
  const v = renderTaskCard(card({ body: "<b>bold</b> & <script>x</script>", title: "A < B" }), "uz");
  assert(v.text.includes("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;"), v.text);
  assert(v.text.includes("A &lt; B"));
  assert(!v.text.includes("<script>"));
});

Deno.test("the rendered card always fits one Telegram message", () => {
  const v = renderTaskCard(card({ body: "x".repeat(9000) }), "uz");
  assert(v.text.length <= 4000, String(v.text.length));
});

Deno.test("instagram tasks and all three locales render their own words", () => {
  assert(renderTaskCard(card({ type: "instagram", points: 8 }), "uz").text.includes("📸 Instagram"));
  assert(renderTaskCard(card(), "ru").text.includes("5 октября (понедельник)"));
  assert(renderTaskCard(card(), "en").text.includes("5 October (Monday)"));
  assertEquals(dayLabel("2026-11-06", 5, "uz"), "6-noyabr (juma)");
});

Deno.test("refusalText: each reason the RPCs report becomes its own sentence, never a raw code", () => {
  assert(refusalText("past_day", "uz").includes("O‘tgan kun"));
  assert(refusalText("post_too_long", "uz").includes("juda uzun"));
  assert(refusalText("not_found", "uz").includes("topilmadi"));
  assert(refusalText("cancelled", "uz").includes("bekor qilingan"));
  assert(refusalText("not_draft", "uz").includes("allaqachon"));
  // an unknown reason still says something useful, and carries the database's own words when given
  assert(refusalText("something_new", "uz", { error: "boom" }).includes("boom"));
  assert(refusalText(null, "en").length > 0);
});
