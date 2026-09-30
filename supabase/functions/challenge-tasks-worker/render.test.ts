// Unit tests for challenge-tasks-worker/render.ts (pure). The SQL side of the same copy (the fallback poster's button
// text) is asserted equal to POST_BUTTON_TEXT by the PGlite harness (_challenge/testing/daily-tasks-worker-check.ts).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  POST_BUTTON_TEXT, postKeyboard, renderBackfillDm, renderEveningDm, renderMorningDm, renderResultDm, renderSummary, toLocale,
} from "./render.ts";

const BOT = "aicreatorsdarsliklari_bot";

Deno.test("postKeyboard: the group-safe t.me/<bot>?start=dt_<id> button (C10)", () => {
  assertEquals(postKeyboard(12, BOT), { inline_keyboard: [[{ text: POST_BUTTON_TEXT, url: `https://t.me/${BOT}?start=dt_12` }]] });
  assertEquals(postKeyboard(12, "@" + BOT)?.inline_keyboard[0][0].url, `https://t.me/${BOT}?start=dt_12`);
  assertEquals(postKeyboard(12, ""), null, "no bot username → no button (never a broken link)");
  assertEquals(postKeyboard(0, BOT), null);
  assertEquals(postKeyboard(Number.NaN, BOT), null);
});

Deno.test("postKeyboard: a Mini App link only when the config parser let one through", () => {
  assertEquals(postKeyboard(7, BOT, `https://t.me/${BOT}/app`)?.inline_keyboard[0][0].url, `https://t.me/${BOT}/app?startapp=dt_7`);
  assertEquals(postKeyboard(7, BOT, `https://t.me/${BOT}/app?startapp=x`)?.inline_keyboard[0][0].url, `https://t.me/${BOT}/app?startapp=x`);
  assertEquals(postKeyboard(7, BOT, "https://evil.example/app")?.inline_keyboard[0][0].url, `https://t.me/${BOT}?start=dt_7`,
    "a malformed link falls back to the bot deep link");
});

Deno.test("renderSummary: anonymous counts, the zero case, the late-rule footer", () => {
  const s = renderSummary({ done: 12, on_time: 10, checking: 3, needs_more: 2, task_date: "2026-10-05" });
  assert(s.startsWith("📊 <b>Bugungi vazifa natijasi</b> (5-oktabr)"));
  assert(s.includes("✅ Topshirdi: 12 (o‘z vaqtida: 10)"));
  assert(s.includes("👀 Tekshirilmoqda: 3"));
  assert(s.includes("✍️ To‘ldirish kerak: 2"));
  assert(s.includes("23:59 gacha"));
  const z = renderSummary({ done: 0, on_time: 0, checking: 0, needs_more: 0 });
  assert(z.includes("📭 Bugun hali hech kim topshirmadi."));
  assert(!z.includes("Topshirdi"));
  assert(renderSummary(null).includes("📭"), "a missing summary object never throws");
});

Deno.test("renderMorningDm: title escaped, points, where to post, topic + task-card buttons", () => {
  const r = renderMorningDm({ task_id: 5, day_no: 3, title: "<AI> & rasm", points: 5, topic_url: "https://t.me/c/4440955972/144" },
    { locale: "uz", name: "Ali <Vali>", botUsername: BOT });
  assertEquals(r.text.split("\n")[0], "☀️ Ali, xayrli tong! 3-kun vazifasi e’lon qilindi:");
  assert(r.text.includes("<b>&lt;AI&gt; &amp; rasm</b>"));
  assert(r.text.includes("🏆 +5 ball — bugun 23:59 gacha."));
  assertEquals(r.keyboard, {
    inline_keyboard: [[{ text: "📅 Kunlik vazifalar topigi", url: "https://t.me/c/4440955972/144" },
                       { text: "📋 Vazifa matni", url: `https://t.me/${BOT}?start=dt_5` }]],
  });
  const ru = renderMorningDm({ task_id: 5, title: "T", points: 8 }, { locale: "ru", name: "", botUsername: BOT });
  assert(ru.text.startsWith("☀️ Доброе утро!"));
  const en = renderMorningDm({ task_id: 5, title: "T", topic_url: "javascript:alert(1)" }, { locale: "en", botUsername: "" });
  assertEquals(en.keyboard, null, "a non-t.me topic URL and no bot username → no buttons");
});

Deno.test("renderEveningDm: '📅 vazifa seriyasi', today's line + missed lines; nothing pending → nothing to send", () => {
  const p = {
    streak_days: 4, topic_url: "https://t.me/c/1/2",
    pending: [
      { task_id: 9, date: "2026-10-06", title: "Bugun", late_days: 0, points: 5 },
      { task_id: 8, date: "2026-10-05", title: "Kecha", late_days: 1, points: 3 },
    ],
  };
  const r = renderEveningDm(p, { locale: "uz", name: "Madina", botUsername: BOT })!;
  const lines = r.text.split("\n");
  assertEquals(lines[0], "📅 Vazifa seriyasi: 4 kun ketma-ket 🔥");
  assertEquals(lines[1], "Madina, bugungi vazifa hali topshirilmagan: <b>Bugun</b> — 23:59 gacha +5 ball.");
  assertEquals(lines[2], "🔥 Bugun ham topshirsangiz, seriyangiz 5 kunga yetadi.");
  assertEquals(lines[3], "↩️ 5-oktabr vazifasi ham ochiq (kechikkan — +3 ball): <b>Kecha</b>");
  assertEquals(r.keyboard?.inline_keyboard[0][1].url, `https://t.me/${BOT}?start=dt_9`, "the card button opens TODAY's task");
  const missedOnly = renderEveningDm({ streak_days: 0, pending: [{ task_id: 8, date: "2026-10-05", title: "K", late_days: 1, points: 3 }] },
    { locale: "uz", name: "", botUsername: BOT })!;
  assertEquals(missedOnly.text.split("\n")[0], "📅 Vazifa seriyasi");
  assert(!missedOnly.text.includes("ugungi vazifa hali"));
  assertEquals(renderEveningDm({ pending: [] }, { locale: "uz" }), null);
  assertEquals(renderEveningDm({}, { locale: "uz" }), null);
});

Deno.test("renderResultDm: the current state — accepted (on time / late), rejected with the reason, else nothing", () => {
  const base = { task_id: 3, task_date: "2026-10-05", title: "Rasm", topic_url: "https://t.me/c/1/2" };
  assertEquals(renderResultDm({ ...base, status: "accepted", points_awarded: 5, late_days: 0 }, { locale: "uz" })?.text,
    "✅ «Rasm» (5-oktabr) qabul qilindi: +5 ball.");
  assertEquals(renderResultDm({ ...base, status: "accepted", points_awarded: 3, late_days: 1 }, { locale: "uz" })?.text,
    "✅ «Rasm» (5-oktabr) qabul qilindi: +3 ball (kechikkan — yarim ball).");
  assertEquals(renderResultDm({ ...base, status: "rejected", reason: "off_task" }, { locale: "uz" })?.text,
    "🤔 «Rasm» (5-oktabr) qabul qilinmadi: ish vazifa mavzusiga mos kelmadi.");
  assertEquals(renderResultDm({ ...base, status: "rejected", reason: "ig_tag_missing", tag_handle: "@aicreators.students" }, { locale: "uz" })?.text,
    "🤔 «Rasm» (5-oktabr) qabul qilinmadi: postda @aicreators.students belgilanmagan.");
  assertEquals(renderResultDm({ ...base, status: "rejected", reason: "ig_post_old" }, { locale: "uz" })?.text,
    "🤔 «Rasm» (5-oktabr) qabul qilinmadi: Bu post bugun joylanganga o‘xshamaydi. Shu vazifa uchun yangi post joylang.");
  assertEquals(renderResultDm({ ...base, status: "rejected", reason: "???" }, { locale: "uz" })?.text,
    "🤔 «Rasm» (5-oktabr) qabul qilinmadi: vazifa talablariga mos kelmadi.");
  for (const st of ["withdrawn", "merged", "checking", "needs_more", "voided"]) {
    assertEquals(renderResultDm({ ...base, status: st }, { locale: "uz" }), null, st);
  }
  assert(renderResultDm({ ...base, status: "accepted", points_awarded: 5 }, { locale: "ru" })!.text.startsWith("✅ «Rasm» (5 октября) принято"));
});

Deno.test("renderBackfillDm and toLocale", () => {
  assertEquals(renderBackfillDm({ submissions: 3, points: 13 }, { locale: "uz", name: "Aziz" })?.text,
    "🎉 Aziz, kunlik vazifalardagi avvalgi ishlaringiz hisoblandi: 3 ta ish, jami +13 ball.");
  assertEquals(renderBackfillDm({ submissions: 0, points: 0 }, { locale: "uz" }), null);
  assertEquals(toLocale("ru-RU"), "ru");
  assertEquals(toLocale("en"), "en");
  assertEquals(toLocale(null), "uz");
  assertEquals(toLocale("de"), "uz");
});
