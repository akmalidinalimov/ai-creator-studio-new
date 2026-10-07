// Tests for the daily-task renderer (Daily Tasks PR-4). Run: deno test supabase/functions/_shared/daily-task-render.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  botStartUrl, correctionKeyboard, correctionToast, DAILY_COPY, dtCallbackData, type DtPayload, formatTaskDate,
  parseDailyStartArg, parseDtCallback, reactionFor, renderCard, renderHint, renderIgStart, renderMergedNote, renderReceipt,
  ruBall, safeName, taskLabel, TELEGRAM_TEXT_MAX,
} from "./daily-task-render.ts";

// The shape challenge_task_payload returns (PR-3), trimmed to what the renderer reads.
function payload(over: Partial<DtPayload["submission"]> & { alternatives?: DtPayload["alternatives"]; streak?: DtPayload["streak"] } = {}): DtPayload {
  const { alternatives, streak, ...sub } = over;
  return {
    status: "ok", outcome: "created", user_id: "u1",
    submission: {
      id: 41, status: "accepted", reason: null, missing: [], hold_reason: null, points: 5, potential_points: 5, late_days: 0,
      attempts_left: 3, attributed_via: "today", moved_count: 0, receipt_message_id: null, receipt_version: 1,
      task: { id: 7, date: "2026-10-05", day_no: 1, type: "general", title: "Birinchi prompt" },
      ...sub,
    },
    alternatives: alternatives ?? [{ task_id: 6, date: "2026-10-04", rel: "yesterday" }],
    streak: streak ?? { days: 1, milestone_bonus: null },
    reaction: "👍",
  };
}

Deno.test("formatTaskDate: uz / ru / en, and junk passes through", () => {
  assertEquals(formatTaskDate("2026-09-30", "uz"), "30-sentabr");
  assertEquals(formatTaskDate("2026-10-05", "ru"), "5 октября");
  assertEquals(formatTaskDate("2026-10-05", "en"), "Oct 5");
  assertEquals(formatTaskDate("x", "uz"), "x");
});

Deno.test("ruBall: 1 балл · 2–4 балла · 5+/11–14 баллов", () => {
  assertEquals([1, 2, 4, 5, 11, 12, 14, 21, 22, 25].map(ruBall),
    ["балл", "балла", "балла", "баллов", "баллов", "баллов", "баллов", "балл", "балла", "баллов"]);
});

Deno.test("receipt: accepted on time = the owner's copy, streak line from 2 days, milestone bonus line", () => {
  const r = renderReceipt(payload({ }), { name: "Ali" });
  assertEquals(r.text, "✅ Bugungi vazifa qabul qilindi: +5 ball.");
  const r2 = renderReceipt(payload({ streak: { days: 4, milestone_bonus: null } }));
  assertEquals(r2.text, "✅ Bugungi vazifa qabul qilindi: +5 ball.\n🔥 4 ta vazifa ketma-ket");
  const r3 = renderReceipt(payload({ streak: { days: 5, milestone_bonus: 10 } }));
  assert(r3.text.endsWith("🎉 Seriya bonusi: +10 ball!"));
});

Deno.test("receipt: accepted LATE = 'Kechagi vazifa (30-sentabr) uchun … (kechikkan — yarim ball)', no streak line", () => {
  const r = renderReceipt(payload({ late_days: 1, points: 3, task: { id: 6, date: "2026-09-30", type: "general" }, streak: { days: 4, milestone_bonus: null } }));
  assertEquals(r.text, "✅ Kechagi vazifa (30-sentabr) uchun qabul qilindi, +3 ball (kechikkan — yarim ball).");
  const r2 = renderReceipt(payload({ late_days: 2, points: 4, task: { id: 5, date: "2026-09-29", type: "instagram" } }));
  assertEquals(r2.text, "✅ 29-sentabr vazifasi uchun qabul qilindi, +4 ball (kechikkan — yarim ball).");
});

Deno.test("receipt: checking — ai_off hold carries the name (escaped), ig hold, plain check", () => {
  assertEquals(renderReceipt(payload({ status: "checking", hold_reason: "ai_off" }), { name: "Ali <b>x" }).text,
    "👀 Ali, qabul qilindi — tekshiruvdan so‘ng ball qo‘shiladi.");
  assertEquals(renderReceipt(payload({ status: "checking", hold_reason: "ai_off" }), { name: "<i>" }).text,
    "👀 &lt;i&gt;, qabul qilindi — tekshiruvdan so‘ng ball qo‘shiladi.");
  assertEquals(renderReceipt(payload({ status: "checking", hold_reason: "ai_off" })).text,
    "👀 Qabul qilindi — tekshiruvdan so‘ng ball qo‘shiladi.");
  assert(renderReceipt(payload({ status: "checking", hold_reason: "ig_waiting_ai" }), { name: "Vali" }).text.startsWith("👀 Vali, Instagram"));
  assertEquals(renderReceipt(payload({ status: "checking" })).text, "👀 Bugungi vazifa tekshirilmoqda… Natija shu xabarda chiqadi.");
});

Deno.test("receipt: needs_more lists what is missing; share / reused IG links get their own line", () => {
  assertEquals(renderReceipt(payload({ status: "needs_more", missing: ["screenshot", "text"] })).text,
    "✍️ Bugungi vazifa uchun yana kerak: skrinshot, qisqa matn (izoh). Shu topikka yuboring — o‘zi qo‘shiladi.");
  const share = renderReceipt(payload({ status: "needs_more", reason: "ig_link_share", missing: ["ig_link"] })).text;
  assert(share.startsWith("✍️ Bu «share» havolasi."));
  assert(share.includes("Instagram post havolasi"));
});

Deno.test("receipt: rejected — reason text, attempts left, IG-old / IG-invalid spec lines, admin free text escaped", () => {
  assertEquals(renderReceipt(payload({ status: "rejected", reason: "image_seen_before", attempts_left: 2 })).text,
    "🤔 Bugungi vazifa qabul qilinmadi: bu rasm boshqa o‘quvchining ishida bor.\nTuzatib, yana 2 marta yuborishingiz mumkin.");
  assertEquals(renderReceipt(payload({ status: "rejected", reason: "ig_post_old", attempts_left: 0 })).text,
    "🤔 Bu post yaqinda joylanganga o‘xshamaydi. Shu vazifa uchun yangi post joylang.\nBu vazifa uchun urinishlar tugadi. Keyingi vazifada omad!");
  assert(renderReceipt(payload({ status: "rejected", reason: "ig_tag_missing" }), { tagHandle: "aicreators.students" }).text
    .includes("postda @aicreators.students belgilanmagan"));
  assert(renderReceipt(payload({ status: "rejected", reason: "Rasm <xira> ko'rinadi" })).text.includes("Rasm &lt;xira&gt; ko'rinadi"));
  assert(renderReceipt(payload({ status: "rejected", reason: "some_new_code" })).text.includes("vazifa talablariga mos kelmadi"));
});

Deno.test("receipt: withdrawn shows ONLY the undo button; merged / expired / voided have none", () => {
  const w = renderReceipt(payload({ status: "withdrawn" }));
  assert(w.text.startsWith("❌ Bu xabar topshiriq sifatida hisoblanmaydi."));
  assertEquals(w.keyboard, { inline_keyboard: [[{ text: "↩️ Qaytarish", callback_data: "dt:r:41" }]] });
  for (const st of ["merged", "expired", "voided", "rejected"]) {
    assertEquals(renderReceipt(payload({ status: st })).keyboard, null, st);
  }
  assertEquals(renderMergedNote(41).text, DAILY_COPY.uz.merged);
  assertEquals(renderMergedNote(41).keyboard, null);
});

Deno.test("buttons: moves from alternatives (today / yesterday / day_before), 'Bu topshiriq emas', <= 2 rows, <= 44 bytes", () => {
  const p = payload({
    late_days: 2, alternatives: [
      { task_id: 9, date: "2026-10-07", rel: "today" },
      { task_id: 8, date: "2026-10-06", rel: "yesterday" },
      { task_id: 3, date: "2026-10-01", rel: "earlier" },
    ],
  });
  const kb = correctionKeyboard(p)!;
  assertEquals(kb.inline_keyboard.length, 2);
  assertEquals(kb.inline_keyboard[0], [
    { text: "📌 Bugungi deb belgilash", callback_data: "dt:m:41:9" },
    { text: "↩️ Kechagi uchun", callback_data: "dt:m:41:8" },
  ]);
  assertEquals(kb.inline_keyboard[1], [{ text: "❌ Bu topshiriq emas", callback_data: "dt:x:41" }]);
  const dayBefore = correctionKeyboard(payload({ alternatives: [{ task_id: 2, date: "2026-10-03", rel: "day_before" }] }))!;
  assertEquals(dayBefore.inline_keyboard[0][0].text, "↩️ 3-oktabr uchun");
  for (const row of kb.inline_keyboard) for (const b of row) if (b.callback_data) assert(new TextEncoder().encode(b.callback_data).length <= 44);
  // moves used up → no move row, the withdraw row stays
  assertEquals(correctionKeyboard(payload({ moved_count: 5 }))!.inline_keyboard, [[{ text: "❌ Bu topshiriq emas", callback_data: "dt:x:41" }]]);
});

Deno.test("buttons: missing instagram_handle → a t.me/<bot>?start=ig URL button; welcome → a bot button (group-safe links)", () => {
  const kb = correctionKeyboard(payload({ status: "needs_more", missing: ["instagram_handle"], alternatives: [] }), { botUsername: "aicreatorsdarsliklari_bot" })!;
  assertEquals(kb.inline_keyboard, [[
    { text: "❌ Bu topshiriq emas", callback_data: "dt:x:41" },
    { text: "📸 Instagram profil", url: "https://t.me/aicreatorsdarsliklari_bot?start=ig" },
  ]]);
  const w = renderReceipt(payload({ alternatives: [] }), { botUsername: "aicreatorsdarsliklari_bot", welcome: true, name: "Ali" });
  assert(w.text.startsWith("👋 <b>Ali</b>, siz AI Creators platformasiga qo‘shildingiz (sinov hisobi)."));
  assertEquals(w.keyboard!.inline_keyboard[0][1], { text: "🤖 Botga ulanish", url: "https://t.me/aicreatorsdarsliklari_bot?start=dt_7" });
  // no bot username → no URL button at all (never a dead link)
  assertEquals(correctionKeyboard(payload({ status: "needs_more", missing: ["instagram_handle"], alternatives: [] }))!.inline_keyboard[0].length, 1);
  assertEquals(botStartUrl("bad name!", "ig"), null);
});

Deno.test("callback data: build and strict parse round-trip; forged shapes are refused", () => {
  assertEquals(parseDtCallback(dtCallbackData({ op: "m", sub: 41, task: 9 })), { op: "m", sub: 41, task: 9 });
  assertEquals(parseDtCallback("dt:x:41"), { op: "x", sub: 41 });
  assertEquals(parseDtCallback("dt:r:41"), { op: "r", sub: 41 });
  for (const bad of ["dt:m:41", "dt:x:0", "dt:x:-1", "dt:y:1", "dt:x:41:9", "dt:m:1:2:3", "hw:x:1", "", "dt:x:99999999999999999999"]) {
    assertEquals(parseDtCallback(bad), null, bad);
  }
  assertEquals(dtCallbackData({ op: "m", sub: 9007199254740991, task: 9007199254740991 }).length <= 44, true);
});

Deno.test("reactionFor: only 👍 🔥 👀 ✍ 🤔 (FE0F-insensitive) — never ✅ or junk", () => {
  assertEquals(reactionFor({ reaction: "✍️" }), "✍");
  assertEquals(reactionFor({ reaction: "🔥" }), "🔥");
  assertEquals(reactionFor({ reaction: "✅" }), null);
  assertEquals(reactionFor({ reaction: null }), null);
  assertEquals(reactionFor(null), null);
});

Deno.test("hints: held has NO button; wrong_group links the own topic (t.me only); no_slot / attempts copy", () => {
  const held = renderHint({ hint: { kind: "held", url: null } }, { name: "Ali" })!;
  assertEquals(held.text, "📌 Ali, ishingizni hisoblash uchun profilingiz bu guruhga biriktirilishi kerak. Admin bilan bog‘laning — xabaringiz saqlanib qoladi (24 soat).");
  assertEquals(held.keyboard, null);
  const wg = renderHint({ hint: { kind: "wrong_group", url: "https://t.me/c/4440955972/144" } })!;
  assertEquals(wg.keyboard, { inline_keyboard: [[{ text: "📅 Mening topigim", url: "https://t.me/c/4440955972/144" }]] });
  assertEquals(renderHint({ hint: { kind: "wrong_group", url: "javascript:alert(1)" } })!.keyboard, null);
  assert(renderHint({ hint: { kind: "no_slot_before_open" } })!.text.startsWith("⏰"));
  assert(renderHint({ hint: { kind: "no_slot_no_open_task" } })!.text.startsWith("📭"));
  assert(renderHint({ hint: { kind: "no_slot_target_closed" } })!.text.startsWith("🔒"));
  assertEquals(renderHint({ hint: { kind: "attempts_exhausted" } }, { maxAttempts: 3 })!.text,
    "🤔 Bu vazifa uchun urinishlar tugadi (3/3). Keyingi vazifada omad!");
  assertEquals(renderHint({ hint: null }), null);
  assertEquals(renderHint({ hint: { kind: "something_else" } }), null);
});

Deno.test("correction toasts: ok per op; every engine refusal is a friendly line (unknown → the generic one)", () => {
  assertEquals(correctionToast("m", { ok: true }), "✅ Ko‘chirildi");
  assertEquals(correctionToast("r", { ok: true }), "↩️ Qaytarildi");
  assertEquals(correctionToast("x", { ok: false, reason: "not_owner" }), "Bu boshqa o‘quvchining ishi 🙂");
  for (const r of ["not_found", "future_task", "same_task", "bad_target", "too_many_moves", "attempts_exhausted", "slot_taken",
    "not_movable", "not_withdrawable", "not_withdrawn", "rejected_final", "withdrawn_by_admin", "closed"]) {
    assert(DAILY_COPY.uz.corr[r] && DAILY_COPY.ru.corr[r] && DAILY_COPY.en.corr[r], r);
    assert(correctionToast("m", { ok: false, reason: r }).length <= 200);
  }
  assertEquals(correctionToast("m", { ok: false, reason: "weird" }), DAILY_COPY.uz.corrDefault);
  assertEquals(correctionToast("m", null), DAILY_COPY.uz.corrDefault);
});

Deno.test("card (/start dt_<id>): post text + status + where-to-submit + topic button; missing / closed / other group / paused", () => {
  const [one] = renderCard({ ok: true, enabled: true, text: "📅 <b>1-kun vazifasi</b>", topic_url: "https://t.me/c/4440955972/144", closed: false,
    submission: { id: 1, status: "accepted", points: 5 } });
  assertEquals(one.text, "📅 <b>1-kun vazifasi</b>\n\n✅ Sizning ishingiz qabul qilingan: +5 ball.\n📍 Ishingizni guruhingizdagi «Qo‘shimcha vazifalar» topigiga yuboring (uy vazifasi topigiga emas).");
  assertEquals(one.keyboard, { inline_keyboard: [[{ text: "📌 Qo‘shimcha vazifalar topigi", url: "https://t.me/c/4440955972/144" }]] });
  assertEquals(renderCard({ ok: false, reason: "no_task" })[0].text, DAILY_COPY.uz.cardMissing);
  const closed = renderCard({ ok: true, text: "x", topic_url: "https://t.me/c/1/2", closed: true })[0];
  assert(closed.text.includes("🔒") && closed.keyboard === null);
  assert(renderCard({ ok: true, text: "x", topic_url: null })[0].text.includes("sizning guruhingiz uchun emas"));
  assert(renderCard({ ok: true, enabled: false, text: "x", topic_url: "https://t.me/c/1/2" })[0].text.includes("⏳"));
  // over Telegram's limit → two messages, the button on the second
  const parts = renderCard({ ok: true, text: "a".repeat(4060), topic_url: "https://t.me/c/1/2" });
  assertEquals(parts.length, 2);
  assert(parts.every((p) => p.text.length <= TELEGRAM_TEXT_MAX));
  assertEquals(parts[1].keyboard !== null, true);
});

Deno.test("/start args and the ig card", () => {
  assertEquals(parseDailyStartArg("dt_12"), { kind: "task", taskId: 12 });
  assertEquals(parseDailyStartArg("ig"), { kind: "ig" });
  for (const bad of ["dt_", "dt_0", "dt_x", "login_abc", "dt_1234567890123"]) assertEquals(parseDailyStartArg(bad), null, bad);
  const have = renderIgStart("@ali_uz", "https://aicreator.academy/auth/magic?t=x");
  assertEquals(have.text, "📸 Instagram profilingiz: <b>@ali_uz</b>. O‘zgartirish kerak bo‘lsa — Sozlamalar.");
  assertEquals(have.keyboard!.inline_keyboard[0][0].url, "https://aicreator.academy/auth/magic?t=x");
  assertEquals(renderIgStart(null, null).keyboard, null);
});

Deno.test("names, labels and the three locales stay complete", () => {
  assertEquals(safeName("  Ali Valiyev "), "Ali");
  assertEquals(safeName(null), "");
  assertEquals(taskLabel({ id: 1, status: "accepted", late_days: 0 }), "Bugungi vazifa");
  for (const loc of ["uz", "ru", "en"] as const) {
    const c = DAILY_COPY[loc];
    for (const k of ["screenshot", "video", "file", "text", "link", "ig_link", "voice", "instagram_handle"]) assert(c.missing[k], `${loc}:${k}`);
    const r = renderReceipt(payload({ status: "needs_more", missing: ["screenshot"] }), { locale: loc });
    assert(r.text.startsWith("✍️"), loc);
  }
});

Deno.test("taskLabel: with grace_days a next-day ON-TIME submission (late_days 0) is labelled by rel_days, not as today's", () => {
  const task = { id: 2, date: "2026-10-05" };
  assertEquals(taskLabel({ id: 1, status: "accepted", late_days: 0, task: { ...task, rel_days: 0 } }), "Bugungi vazifa");
  assertEquals(taskLabel({ id: 1, status: "accepted", late_days: 0, task: { ...task, rel_days: 1 } }), "Kechagi vazifa (5-oktabr)");
  assertEquals(taskLabel({ id: 1, status: "accepted", late_days: 0, task: { ...task, rel_days: 3 } }), "5-oktabr vazifasi");
  assertEquals(taskLabel({ id: 1, status: "accepted", late_days: 1, task }), "Kechagi vazifa (5-oktabr)", "an older payload: late_days");
});

Deno.test("Instagram mix-ups guide the student in steps; a free mix-up shows no attempts line (2026-10-07)", () => {
  const sub = (reason: string) => ({ submission: { id: 1, status: "rejected", reason, task_date: "2026-10-07", attempts_left: 2 } });
  const not = renderReceipt(sub("not_instagram") as any, { locale: "uz" }).text;
  assert(not.includes("Instagram’ga joylang") && not.includes("username") && not.includes("Havola va teg shart emas"), not);
  assert(!not.includes("yana 2 marta"), "a free mix-up does not show the attempts line");
  const ru = renderReceipt(sub("ig_handle_not_visible") as any, { locale: "ru" }).text;
  assert(ru.includes("рядом с фото профиля"), ru);
  const mismatch = renderReceipt(sub("ig_handle_mismatch") as any, { locale: "uz" }).text;
  assert(mismatch.includes("/instagram") && mismatch.includes("yana 2 marta"), "a wrong account still counts: " + mismatch);
});
