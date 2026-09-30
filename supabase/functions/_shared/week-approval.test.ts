// Tests for the weekly approval renderer (Daily Tasks PR-9). Run: deno test supabase/functions/_shared/week-approval.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  askKeyboard, BTN, dayLine, dtwData, MAX_TEXT, parseDtwCallback, rangeLabel, renderAsk, renderConfirm, renderKind,
  renderNoTasks, renderResult, requiresShort, reviewUrl, toWeekView, type WeekTask, type WeekView, weekLabel,
} from "./week-approval.ts";

const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
const TEXT = { any: ["text"], min: 1, label: "text" };
const IG = { any: ["ig_link"], min: 1, label: "ig_link" };

function task(id: number, date: string, over: Partial<WeekTask> = {}): WeekTask {
  return { id, date, type: "general", title: `Vazifa ${id}`, status: "draft", points: 5, requires: [SHOT, TEXT], accepts: ["text", "photo", "document"], ...over };
}

function week(tasks: WeekTask[], over: Partial<WeekView> = {}): WeekView {
  return {
    week_start: "2026-10-05", week_end: "2026-10-11", tasks, missing: [], post_time: "09:00",
    admin_url: "https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05", ...over,
  };
}

Deno.test("parseDtwCallback: the three actions on a real Monday only; everything else is refused", () => {
  assertEquals(parseDtwCallback("dtw:a:20261005"), { action: "a", week: "2026-10-05", compact: "20261005" });
  assertEquals(parseDtwCallback("dtw:y:20261012")?.action, "y");
  assertEquals(parseDtwCallback("dtw:b:20261012")?.week, "2026-10-12");
  for (const bad of ["dtw:a:20261006", "dtw:x:20261005", "dtw:a:20261305", "dtw:a:2026-10-05", "dt:a:20261005", "dtw:a:20261005 ", "", null, 5]) {
    assertEquals(parseDtwCallback(bad), null, String(bad));
  }
  assertEquals(dtwData("y", "2026-10-05"), "dtw:y:20261005");
  for (const a of ["a", "y", "b"] as const) assert(new TextEncoder().encode(dtwData(a, "2026-10-05")).length <= 64);
  assertEquals(reviewUrl("2026-10-05"), "https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05");
});

Deno.test("dates: weekday + Uzbek month, week ranges within and across months", () => {
  assertEquals(dayLine("2026-10-05"), "Du, 5-oktabr");
  assertEquals(dayLine("2026-10-11"), "Ya, 11-oktabr");
  assertEquals(rangeLabel("2026-10-05", "2026-10-09"), "5–9 oktabr");
  assertEquals(rangeLabel("2026-09-28", "2026-10-02"), "28 sentabr – 2 oktabr");
  assertEquals(rangeLabel("2026-10-05", "2026-10-05"), "5 oktabr");
  assertEquals(weekLabel(week([task(1, "2026-10-05"), task(2, "2026-10-09")])), "5–9 oktabr");
  assertEquals(weekLabel(week([task(1, "2026-10-06")], { missing: ["2026-10-05"] })), "5–6 oktabr");
  assertEquals(weekLabel(week([])), "5–11 oktabr");
});

Deno.test("requiresShort: the requires groups the owner must review, else the accepted kinds", () => {
  assertEquals(requiresShort([SHOT, TEXT]), "Skrinshot / rasm + Matn");
  assertEquals(requiresShort([{ ...SHOT, min: 3 }, IG]), "Skrinshot / rasm ×3 + Instagram havolasi");
  assertEquals(requiresShort([], ["text", "photo"]), "istalgan bittasi (matn, rasm)");
  assertEquals(requiresShort(null, null), "istalgan bitta ish");
});

Deno.test("renderAsk: every day with weekday, date, type, points and the requirement; approve + review buttons", () => {
  const v = week([
    task(1, "2026-10-05", { title: "Prompt <yozish> & tahlil" }),
    task(2, "2026-10-06", { type: "instagram", points: 8, requires: [SHOT, IG] }),
    task(3, "2026-10-07", { status: "approved" }),
  ], { missing: ["2026-10-08", "2026-10-09"] });
  const r = renderAsk(v, "ask");
  assert(r.text.startsWith("📅 <b>Keyingi hafta vazifalari (5–9 oktabr)</b>"), r.text);
  assert(r.text.includes("QORALAMA"));
  assert(r.text.includes("<b>Du, 5-oktabr</b> · 📝 umumiy · 5 ball\nPrompt &lt;yozish&gt; &amp; tahlil\nTopshirish: Skrinshot / rasm + Matn"), r.text);
  assert(r.text.includes("<b>Se, 6-oktabr</b> · 📸 Instagram · 8 ball"), r.text);
  assert(r.text.includes("Topshirish: Skrinshot / rasm + Instagram havolasi"));
  assert(r.text.includes("✅ Vazifa 3"), "an approved day is marked");
  assert(r.text.includes("<b>Pa, 8-oktabr</b> — ⚠️ vazifa yo‘q"));
  assert(r.text.includes("Jami: 2 ta qoralama, 1 ta tasdiqlangan, 2 kun vazifasiz."), r.text);
  // the days come in date order, the missing ones between the tasks
  assert(r.text.indexOf("Ch, 7-oktabr") < r.text.indexOf("Pa, 8-oktabr"));
  assertEquals(r.keyboard, {
    inline_keyboard: [
      [{ text: BTN.approve, callback_data: "dtw:a:20261005" }],
      [{ text: BTN.review, url: "https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05" }],
    ],
  });
  const rem = renderAsk(v, "remind");
  assert(rem.text.startsWith("⏰ <b>Eslatma: keyingi hafta vazifalari hali tasdiqlanmagan (5–9 oktabr)</b>"), rem.text);
  assert(rem.text.includes("09:00 da guruhlarga vazifa chiqmaydi"));
});

Deno.test("renderAsk: no draft left -> the review button only", () => {
  const kb = askKeyboard(week([task(1, "2026-10-05", { status: "approved" })]));
  assertEquals(kb.inline_keyboard.length, 1);
  assertEquals(kb.inline_keyboard[0][0].text, BTN.review);
});

Deno.test("renderConfirm: 'N ta vazifa tasdiqlansinmi?' with Ha / Orqaga", () => {
  const r = renderConfirm(week([task(1, "2026-10-05"), task(2, "2026-10-06"), task(3, "2026-10-07", { status: "approved" })]));
  assert(r.text.includes("❓ <b>2 ta vazifa tasdiqlansinmi?</b>"), r.text);
  assertEquals(r.keyboard, { inline_keyboard: [[{ text: BTN.yes, callback_data: "dtw:y:20261005" }, { text: BTN.back, callback_data: "dtw:b:20261005" }]] });
});

Deno.test("renderResult: N/M with the admin's name, failures listed with the review link; the already-approved answer", () => {
  const after = week([task(1, "2026-10-05", { status: "approved" }), task(2, "2026-10-06")]);
  const r = renderResult(after, {
    approved: 1, already_approved: 1, drafts_left: 1,
    failed: [{ date: "2026-10-06", title: "Uzun <post>", error: "E’lon matni juda uzun: 4100 / 4000 belgi — matnni qisqartiring" }],
  }, "Bahrom");
  assert(r.text.startsWith("⚠️ <b>Keyingi hafta vazifalari: 1/2 tasdiqlandi</b> (5–6 oktabr) — Bahrom"), r.text);
  assert(r.text.includes("Avval tasdiqlangan: 1 ta."));
  assert(r.text.includes("• Se, 6-oktabr — «Uzun &lt;post&gt;»: E’lon matni juda uzun"), r.text);
  assert(r.text.includes(BTN.review));
  assertEquals(r.keyboard?.inline_keyboard[0][0].callback_data, "dtw:a:20261005", "a draft remains: approve again after the fix");
  const ok = renderResult(week([task(1, "2026-10-05", { status: "approved" })]), { approved: 5, already_approved: 0, failed: [] }, "Admin");
  assert(ok.text.startsWith("✅ <b>Keyingi hafta vazifalari: 5/5 tasdiqlandi</b>"), ok.text);
  assertEquals(ok.keyboard?.inline_keyboard.length, 1, "nothing left: the review link only");
  const again = renderResult(week([task(1, "2026-10-05", { status: "approved" })]), { approved: 0, already_approved: 5, failed: [] }, "Admin");
  assert(again.text.startsWith("ℹ️ <b>Bu hafta allaqachon tasdiqlangan"), again.text);
  assert(again.text.includes("Tasdiqlangan: 5 ta vazifa"));
});

Deno.test("renderNoTasks + renderKind", () => {
  const v = week([], { missing: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"] });
  const r = renderNoTasks(v);
  assert(r.text.startsWith("📭 <b>Keyingi haftaga vazifa yo‘q (5–9 oktabr)</b>"), r.text);
  assert(r.text.includes("Du, 5-oktabr, Se, 6-oktabr"));
  assertEquals(r.keyboard?.inline_keyboard[0][0].text, BTN.review);
  assertEquals(renderKind("no_tasks", v)?.text, r.text);
  assertEquals(renderKind("remind", week([task(1, "2026-10-05")]))?.text.startsWith("⏰"), true);
  assertEquals(renderKind("other", v), null);
});

Deno.test("a long week always fits one Telegram message", () => {
  const long = "Juda uzun sarlavha ".repeat(10).slice(0, 120);
  const tasks: WeekTask[] = [];
  for (let c = 0; c < 6; c++) {
    for (let d = 0; d < 7; d++) {
      tasks.push(task(c * 10 + d, `2026-10-${String(5 + d).padStart(2, "0")}`, {
        title: long, course_title: `Kurs ${c} `.repeat(8), requires: [SHOT, TEXT, { ...SHOT, label: "video", min: 4 }, IG, TEXT, TEXT, TEXT, TEXT],
      }));
    }
  }
  const v = week(tasks, { multi_course: true });
  for (const r of [renderAsk(v, "ask"), renderAsk(v, "remind"), renderConfirm(v)]) {
    assert(r.text.length <= MAX_TEXT, `${r.text.length}`);
    assert(r.text.includes("yana"), "the overflow says how many more");
  }
});

Deno.test("toWeekView: junk never throws", () => {
  assertEquals(toWeekView(null, "2026-10-05").tasks, []);
  assertEquals(toWeekView({ tasks: [{ date: "x" }, { id: 1, date: "2026-10-05", title: "T", status: "draft", points: 5 }] }, "2026-10-05").tasks.length, 1);
  assertEquals(toWeekView({ week_start: "2026-10-12", missing: ["2026-10-12", 3] }, "2026-10-05").missing, ["2026-10-12"]);
});
