// Pins the teacher bot surfaces (teacher-ux.ts): the new-homework DM keyboard (flag off = today's, byte-identical),
// the rejection fallback, the 👤 Profil card rows and send/edit fallback, and the /start text.
// Run: deno test supabase/functions/telegram-bot-webhook/teacher-ux.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  editTeacherCard,
  hwTeacherDmKeyboard,
  isButtonRejection,
  sendHwTeacherDm,
  sendTeacherCard,
  teacherCardKeyboard,
  teacherCardRows,
  teacherStartGreeting,
  withoutWebApp,
} from "./teacher-ux.ts";
import { _resetTeacherMiniAppFlagCache } from "../_shared/teacher-miniapp.ts";
import { DEFAULT_MINIAPP_BASE } from "../_shared/miniapp-button.ts";
import type { SendOutcome } from "../_shared/telegram-send.ts";

const SUB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const G = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const TOPIC = "https://t.me/c/2123456789/15/42";

/** A fake service-role client: platform_settings answers the teacher flag; admin_actions records health rows. */
function fakeAdmin(flagValue: unknown) {
  const health: any[] = [];
  const admin = {
    health,
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: table === "platform_settings" ? flagValue : null, error: null }),
        insert: (row: any) => { health.push(row); return Promise.resolve({ error: null }); },
      };
      return q;
    },
  };
  return admin;
}
const FLAG_ON = { value: { enabled: true } };
const FLAG_OFF = { value: { enabled: false } };

const ok = (): SendOutcome => ({ ok: true, status: 200, error: null, terminal: false, recipient: false, content: false });
const bad = (error: string, status = 400): SendOutcome => ({ ok: false, status, error, terminal: true, recipient: false, content: false });

// ─────────────────────────── the new-homework DM ───────────────────────────
Deno.test("DM keyboard: teacher Mini App off → exactly the old inline keyboard", () => {
  for (const guessed of [false, true]) {
    const old = [
      [{ text: "🎯 Baholash", callback_data: `grade:open:${SUB}` }],
      ...(guessed ? [[{ text: "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${SUB}` }]] : []),
      [{ text: "📌 Topikga o'tish", url: TOPIC }],
    ];
    assertEquals(
      JSON.stringify(hwTeacherDmKeyboard({ submissionId: SUB, messageUrl: TOPIC, guessed, gradeApp: null })),
      JSON.stringify({ inline_keyboard: old }),
    );
  }
});

Deno.test("DM keyboard: Mini App on → 🎯 ↗ first, the in-chat flow second, callbacks ≤ 64 bytes", () => {
  const app = { text: "🎯 Baholash", web_app: { url: "https://x.example/tg/teacher/grade" } };
  const kb = hwTeacherDmKeyboard({ submissionId: SUB, messageUrl: TOPIC, guessed: true, gradeApp: app });
  assertEquals(kb.inline_keyboard, [
    [app],
    [{ text: "🎤 Chatda (ovoz bilan)", callback_data: `grade:open:${SUB}` }],
    [{ text: "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${SUB}` }],
    [{ text: "📌 Topikga o'tish", url: TOPIC }],
  ]);
  for (const row of kb.inline_keyboard) for (const b of row) if (b.callback_data) assert(new TextEncoder().encode(b.callback_data).length <= 64);
});

Deno.test("sendHwTeacherDm: flag on → one send, web_app to THIS submission, tracked", async () => {
  _resetTeacherMiniAppFlagCache();
  const sent: any[] = [];
  const out = await sendHwTeacherDm(fakeAdmin(FLAG_ON), { chatId: 777, body: "b", submissionId: SUB, messageUrl: TOPIC, guessed: false },
    { send: (p) => { sent.push(p); return Promise.resolve(ok()); } });
  assertEquals(out, { ok: true, status: 200, error: null, button: "web_app" });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].parse_mode, "HTML");
  assertEquals(sent[0].disable_web_page_preview, true);
  assertEquals(sent[0].reply_markup.inline_keyboard[0][0].web_app.url,
    `${DEFAULT_MINIAPP_BASE}/tg/teacher/grade?sub=${SUB}&src=teacher_hw_dm&ref=${SUB}`);
  _resetTeacherMiniAppFlagCache();
});

Deno.test("sendHwTeacherDm: flag off → today's keyboard, one send", async () => {
  _resetTeacherMiniAppFlagCache();
  const sent: any[] = [];
  const out = await sendHwTeacherDm(fakeAdmin(FLAG_OFF), { chatId: 777, body: "b", submissionId: SUB, messageUrl: TOPIC, guessed: false },
    { send: (p) => { sent.push(p); return Promise.resolve(ok()); } });
  assertEquals(out.button, "callback");
  assertEquals(sent[0].reply_markup, hwTeacherDmKeyboard({ submissionId: SUB, messageUrl: TOPIC, guessed: false, gradeApp: null }));
  _resetTeacherMiniAppFlagCache();
});

Deno.test("sendHwTeacherDm: Telegram rejects the web_app button → resent ONCE with today's keyboard + alarm", async () => {
  _resetTeacherMiniAppFlagCache();
  const admin = fakeAdmin(FLAG_ON);
  const sent: any[] = [];
  const out = await sendHwTeacherDm(admin, { chatId: 777, body: "b", submissionId: SUB, messageUrl: TOPIC, guessed: false },
    { send: (p) => { sent.push(p); return Promise.resolve(sent.length === 1 ? bad("Bad Request: BUTTON_TYPE_INVALID") : ok()); } });
  assertEquals(sent.length, 2);
  assertEquals(sent[1].reply_markup, hwTeacherDmKeyboard({ submissionId: SUB, messageUrl: TOPIC, guessed: false, gradeApp: null }));
  assertEquals(out, { ok: true, status: 200, error: null, button: "callback" });
  // The TEACHER fault row; never the student watch-button alarm's miniapp_button_rejected (watch_button_health, any fn).
  assert(admin.health.some((r) => r.action === "teacher_miniapp_button_rejected"));
  assertEquals(admin.health.filter((r) => r.action === "miniapp_button_rejected").length, 0);
  _resetTeacherMiniAppFlagCache();
});

Deno.test("sendHwTeacherDm: a blocked teacher is NOT resent (recipient error) and never throws", async () => {
  _resetTeacherMiniAppFlagCache();
  let n = 0;
  const out = await sendHwTeacherDm(fakeAdmin(FLAG_ON), { chatId: 777, body: "b", submissionId: SUB, messageUrl: TOPIC, guessed: false },
    { send: () => { n++; return Promise.resolve(bad("Forbidden: bot was blocked by the user", 403)); } });
  assertEquals(n, 1);
  assertEquals(out.ok, false);
  const thrown = await sendHwTeacherDm(fakeAdmin(FLAG_ON), { chatId: 777, body: "b", submissionId: SUB, messageUrl: TOPIC, guessed: false },
    { send: () => { throw new Error("boom"); } });
  assertEquals(thrown.ok, false);
  _resetTeacherMiniAppFlagCache();
});

// ─────────────────────────── the 👤 Profil card ───────────────────────────
Deno.test("card rows: a teacher gets TOP / Faolsizlar for THIS group + Sozlamalar, then the app row, then switchers", () => {
  const stats = { text: "📊 Statistika", web_app: { url: "u1" } };
  const broadcast = { text: "📣 Guruhga xabar", web_app: { url: "u2" } };
  const sw = [[{ text: "👥 2-GURUH", callback_data: `tprof:g:${SUB}` }]];
  const rows = teacherCardRows({ locale: "uz", groupId: G, canPick: true, stats, broadcast, switchRows: sw });
  assertEquals(rows, [
    [
      { text: "🏆 TOP", callback_data: `tg:pick:ttop:${G}` },
      { text: "😴 Faolsizlar", callback_data: `tg:pick:tinactive:${G}` },
      { text: "⚙️ Sozlamalar", callback_data: "prof:settings" },
    ],
    [stats, broadcast],
    ...sw,
  ]);
  for (const row of rows) for (const b of row) if (b.callback_data) assert(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
});

Deno.test("card rows: an admin (tg:pick answers teachers only) or a bad group id gets Sozlamalar alone; no app buttons → no app row", () => {
  assertEquals(teacherCardRows({ locale: "ru", groupId: G, canPick: false, stats: null, broadcast: null, switchRows: [] }),
    [[{ text: "⚙️ Настройки", callback_data: "prof:settings" }]]);
  assertEquals(teacherCardRows({ locale: "en", groupId: "not-a-uuid", canPick: true, stats: null, broadcast: null, switchRows: [] }),
    [[{ text: "⚙️ Settings", callback_data: "prof:settings" }]]);
});

Deno.test("card keyboard: private chat + flag on → 📊 and 📣 open the teacher app; no chat id → no app buttons", async () => {
  _resetTeacherMiniAppFlagCache();
  const kb = await teacherCardKeyboard(fakeAdmin(FLAG_ON), { chatId: 55, locale: "uz", groupId: G, canPick: true, switchRows: [] });
  assertEquals(kb.inline_keyboard[1], [
    { text: "📊 Statistika", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teacher/stats?src=teacher_card` } },
    { text: "📣 Guruhga xabar", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teacher/broadcast?src=teacher_card` } },
  ]);
  const noChat = await teacherCardKeyboard(fakeAdmin(FLAG_ON), { chatId: null, locale: "uz", groupId: G, canPick: true, switchRows: [] });
  assertEquals(noChat.inline_keyboard.length, 1);
  const off = await (async () => { _resetTeacherMiniAppFlagCache(); return teacherCardKeyboard(fakeAdmin(FLAG_OFF), { chatId: 55, locale: "uz", groupId: G, canPick: true, switchRows: [] }); })();
  assertEquals(off.inline_keyboard.length, 1);
  _resetTeacherMiniAppFlagCache();
});

Deno.test("withoutWebApp: drops web_app buttons and empty rows", () => {
  const kb = { inline_keyboard: [[{ text: "a", callback_data: "x" }], [{ text: "b", web_app: { url: "u" } }], [{ text: "c", web_app: { url: "u" } }, { text: "d", url: "https://t.me/c/1/2" }]] };
  assertEquals(withoutWebApp(kb), { inline_keyboard: [[{ text: "a", callback_data: "x" }], [{ text: "d", url: "https://t.me/c/1/2" }]] });
  assertEquals(withoutWebApp({ inline_keyboard: [[{ text: "b", web_app: { url: "u" } }]] }), undefined);
  assertEquals(withoutWebApp(undefined), undefined);
});

Deno.test("isButtonRejection: only a 400 about a button", () => {
  assert(isButtonRejection({ ok: false, status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" }));
  assert(isButtonRejection({ ok: false, status: 400, error: "Bad Request: inline keyboard button Web App URL 'x' is invalid" }));
  assert(!isButtonRejection({ ok: false, status: 400, error: "Bad Request: message to edit not found" }));
  assert(!isButtonRejection({ ok: false, status: 400, error: "Bad Request: message can't be edited" }));
  assert(!isButtonRejection({ ok: false, status: 403, error: "Forbidden: bot was blocked by the user" }));
});

const CARD_KB = { inline_keyboard: [[{ text: "⚙️ Sozlamalar", callback_data: "prof:settings" }], [{ text: "📊", web_app: { url: "u" } }]] };

Deno.test("sendTeacherCard: HTML, no preview, recorded; a rejected web_app button → resent once without it + alarm", async () => {
  const admin = fakeAdmin(FLAG_ON);
  const calls: { m: string; p: any; r: boolean }[] = [];
  const out = await sendTeacherCard(admin, 9, "card", CARD_KB, {
    send: (m, p, r) => { calls.push({ m, p, r }); return Promise.resolve(calls.length === 1 ? bad("Bad Request: BUTTON_TYPE_INVALID") : ok()); },
  });
  assertEquals(out.ok, true);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].m, "sendMessage");
  assertEquals(calls[0].r, true);
  assertEquals(calls[0].p.parse_mode, "HTML");
  assertEquals(calls[0].p.disable_web_page_preview, true);
  assertEquals(calls[1].p.reply_markup, { inline_keyboard: [[{ text: "⚙️ Sozlamalar", callback_data: "prof:settings" }]] });
  // The TEACHER fault row; never the student watch-button alarm's miniapp_button_rejected (watch_button_health, any fn).
  assert(admin.health.some((r) => r.action === "teacher_miniapp_button_rejected"));
  assertEquals(admin.health.filter((r) => r.action === "miniapp_button_rejected").length, 0);
});

Deno.test("editTeacherCard: 'not modified' is a success; 'message to edit not found' is neither retried nor alarmed", async () => {
  const admin = fakeAdmin(FLAG_ON);
  let n = 0;
  const same = await editTeacherCard(admin, 9, 100, "card", CARD_KB, { send: () => { n++; return Promise.resolve(bad("Bad Request: message is not modified: specified new message content and reply markup are exactly the same")); } });
  assertEquals(same.ok, true);
  assertEquals(n, 1);
  n = 0;
  const gone = await editTeacherCard(admin, 9, 100, "card", CARD_KB, { send: (m, p, r) => { n++; assertEquals(m, "editMessageText"); assertEquals(p.message_id, 100); assertEquals(r, false); return Promise.resolve(bad("Bad Request: message to edit not found")); } });
  assertEquals(gone.ok, false);
  assertEquals(n, 1);
  assertEquals(admin.health.filter((r) => /miniapp_button_rejected/.test(r.action)).length, 0);
});

// ─────────────────────────── /start ───────────────────────────
Deno.test("teacher /start: pending count, the (now true) Profil line, and the ☰ app line only when the app is on", () => {
  const on = teacherStartGreeting("uz", "Rano", 8, true);
  assert(on.startsWith("Salom, Rano! 🧑‍🏫\n📝 <b>8 ta vazifa</b> baholashni kutmoqda."));
  assert(on.includes("👤 Profil ichida: 🏆 TOP talabalar, 😴 faolsizlar, ⚙️ sozlamalar va guruh almashtirish."));
  assert(on.includes("☰ «📝 Ustoz»"));
  const off = teacherStartGreeting("uz", "Rano", 0, false);
  assert(off.includes("✅ Baholanmagan vazifalar yo'q."));
  assert(!off.includes("☰"));
  assert(teacherStartGreeting("ru", "Р", 3, true).includes("☰ «📝 Устоз»"));
  assert(teacherStartGreeting("en", "R", 1, true).includes("☰ «📝 Teacher»"));
  assert(teacherStartGreeting("uz", "R", Number.NaN, false).includes("✅"));
});
