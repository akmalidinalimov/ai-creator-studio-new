// Pins the ☰ live sync: the exact menu per role / flag / language (unchanged labels and URLs), private chats
// only, the per-chat throttle and when it is bypassed, staff "/" lists, and what each failure records.
// Run: deno test supabase/functions/telegram-bot-webhook/menu-button.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetLiveMenuSync,
  classifyMenuOutcome,
  flagSig,
  liveFresh,
  menuButtonAudience,
  menuButtonFor,
  menuKey,
  syncMenuLive,
} from "./menu-button.ts";
import { FakeDb, fakeTelegram } from "../_bot/testing/fake-db.ts";

const BASE = "https://www.aicreator.academy";
const T0 = Date.parse("2026-10-01T06:00:00Z");

Deno.test("menuButtonFor: the same labels and URLs the bot has always set; default when the role's flag is off", () => {
  assertEquals(menuButtonFor("student", true, "uz", BASE), { type: "web_app", text: "🚀 Ilovani ochish", web_app: { url: `${BASE}/dashboard` } });
  assertEquals(menuButtonFor("student", true, "ru", BASE), { type: "web_app", text: "🚀 Открыть приложение", web_app: { url: `${BASE}/dashboard` } });
  assertEquals(menuButtonFor("teacher", true, "uz", BASE), { type: "web_app", text: "📝 Ustoz", web_app: { url: `${BASE}/tg/teacher` } });
  assertEquals(menuButtonFor("admin", true, "en", BASE), { type: "web_app", text: "📝 Teacher", web_app: { url: `${BASE}/tg/teacher` } });
  assertEquals(menuButtonFor("student", false, "uz", BASE), { type: "default" });
  assertEquals(menuButtonFor("teacher", false, "ru", BASE), { type: "default" });
});

Deno.test("classifyMenuOutcome: recipient → unreachable; web_app 400 → rejected; the rest → failed", () => {
  const o = (ok: boolean, status: number, error: string | null, recipient = false) =>
    ({ ok, status, error, terminal: recipient, recipient, content: false });
  assertEquals(classifyMenuOutcome(o(true, 200, null), true), "ok");
  assertEquals(classifyMenuOutcome(o(false, 400, "Bad Request: chat not found", true), true), "unreachable");
  assertEquals(classifyMenuOutcome(o(false, 400, "Bad Request: BUTTON_URL_INVALID"), true), "rejected");
  assertEquals(classifyMenuOutcome(o(false, 400, "Bad Request: something"), false), "failed");
  assertEquals(classifyMenuOutcome(o(false, 429, "Too Many Requests"), true), "failed");
  assertEquals(classifyMenuOutcome(o(false, 0, "transport_error"), true), "failed");
});

// Incident 2026-10-01: the live answer that froze the sweep. Classified by the REAL shared classifier (fakeTelegram
// uses it), it is now a recipient → unreachable; an unlisted 400 is 'failed' (counted, never "our button"); only a
// positive button / web app 400 is 'rejected'; a 401 is the bot itself → 'global'.
Deno.test("classifyMenuOutcome (real classifier): 'user not found' is unreachable, an unknown 400 is failed, 401 is global", async () => {
  const outcome = async (answer: { ok: boolean; status?: number; error?: string }) =>
    classifyMenuOutcome(await fakeTelegram(() => answer).call("setChatMenuButton", { chat_id: 1 }), true);
  assertEquals(await outcome({ ok: false, status: 400, error: "Bad Request: user not found" }), "unreachable");
  assertEquals(await outcome({ ok: false, status: 400, error: "Bad Request: USER_ID_INVALID" }), "unreachable");
  assertEquals(await outcome({ ok: false, status: 400, error: "Bad Request: something nobody listed" }), "failed");
  assertEquals(await outcome({ ok: false, status: 400, error: "Bad Request: BUTTON_URL_INVALID" }), "rejected");
  assertEquals(await outcome({ ok: false, status: 400, error: "Bad Request: WEBAPP_URL_INVALID" }), "rejected");
  assertEquals(await outcome({ ok: false, status: 401, error: "Unauthorized" }), "global");
  assertEquals(await outcome({ ok: false, status: 404, error: "Not Found" }), "global");
});

Deno.test("live sync: 'user not found' is unreachable — cached, silent, never the student watch-button alarm", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  const tg = fakeTelegram(() => ({ ok: false, status: 400, error: "Bad Request: user not found" }));
  assertEquals(await syncMenuLive(db, 4242, opts({ call: tg.call })), "unreachable");
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  assertEquals(db.actions("teacher_miniapp_button_rejected").length, 0);
  assertEquals(db.actions("menu_button_sync_failed").length, 0);
  _resetLiveMenuSync();
});

Deno.test("live sync: a bot-wide 401 is 'global' — recorded (menu_button_sync_failed), not cached, not a refusal", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  const tg = fakeTelegram(() => ({ ok: false, status: 401, error: "Unauthorized" }));
  assertEquals(await syncMenuLive(db, 4343, opts({ call: tg.call })), "global");
  const rows = db.actions("menu_button_sync_failed");
  assertEquals(rows.length, 1);
  assertEquals([rows[0].details.status, rows[0].details.error], [401, "Unauthorized"]);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  assertEquals(liveFresh(4343, flagSig(true, true, BASE), T0 + 1000), false);
  _resetLiveMenuSync();
});

const opts = (o: Partial<Parameters<typeof syncMenuLive>[2]> = {}) => ({
  role: "student" as const, locale: "uz" as const, on: true, base: BASE, sig: flagSig(true, true, BASE), now: T0, ...o,
});

Deno.test("live sync: applies once, then skips for an hour; a changed state re-applies at once", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  const tg = fakeTelegram();
  assertEquals(await syncMenuLive(db, 555, opts({ call: tg.call })), "ok");
  assertEquals(await syncMenuLive(db, 555, opts({ call: tg.call, now: T0 + 59 * 60_000 })), "skipped");
  assertEquals(tg.calls.length, 1);
  // flag flipped → default menu, applied immediately
  assertEquals(await syncMenuLive(db, 555, opts({ call: tg.call, on: false, now: T0 + 60_000 })), "ok");
  assertEquals(tg.calls[1].payload, { chat_id: 555, menu_button: { type: "default" } });
  // language changed → new label
  assertEquals(await syncMenuLive(db, 555, opts({ call: tg.call, locale: "ru", now: T0 + 120_000 })), "ok");
  // an hour later the same state is re-asserted
  assertEquals(await syncMenuLive(db, 555, opts({ call: tg.call, locale: "ru", now: T0 + 120_000 + 3_600_000 })), "ok");
  assertEquals(tg.calls.length, 4);
  _resetLiveMenuSync();
});

Deno.test("live sync: never for a group chat (negative id)", async () => {
  _resetLiveMenuSync();
  const tg = fakeTelegram();
  assertEquals(await syncMenuLive(new FakeDb(), -1001234, opts({ call: tg.call })), "skipped");
  assertEquals(tg.calls.length, 0);
});

Deno.test("live sync: staff also get their own '/' list; a student does not", async () => {
  _resetLiveMenuSync();
  const tg = fakeTelegram();
  await syncMenuLive(new FakeDb(), 1, opts({ call: tg.call, role: "teacher" }));
  await syncMenuLive(new FakeDb(), 2, opts({ call: tg.call, role: "student" }));
  assertEquals(tg.calls.map((c) => c.method), ["setChatMenuButton", "setMyCommands", "setChatMenuButton"]);
  assertEquals(tg.calls[1].payload.scope, { type: "chat", chat_id: 1 });
  _resetLiveMenuSync();
});

Deno.test("live sync: a failure is recorded and NOT cached (the next interaction retries); unreachable is cached, silent", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  let fail = true;
  const tg = fakeTelegram(() => (fail ? { ok: false, status: 502, error: "Bad Gateway" } : { ok: true }));
  assertEquals(await syncMenuLive(db, 77, opts({ call: tg.call })), "failed");
  assertEquals(db.actions("menu_button_sync_failed").length, 1);
  assertEquals(db.actions("menu_button_sync_failed")[0].details.fn, "menu_button_live");
  fail = false;
  assertEquals(await syncMenuLive(db, 77, opts({ call: tg.call, now: T0 + 1000 })), "ok");

  const blocked = fakeTelegram(() => ({ ok: false, error: "Forbidden: bot was blocked by the user" }));
  assertEquals(await syncMenuLive(db, 78, opts({ call: blocked.call })), "unreachable");
  assertEquals(await syncMenuLive(db, 78, opts({ call: blocked.call, now: T0 + 1000 })), "skipped");
  assertEquals(db.actions("menu_button_sync_failed").length, 1);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  _resetLiveMenuSync();
});

Deno.test("live sync: a refused web_app menu raises the watch-button alarm row", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  const tg = fakeTelegram(() => ({ ok: false, status: 400, error: "Bad Request: WEBAPP_URL_INVALID" }));
  assertEquals(await syncMenuLive(db, 90, opts({ call: tg.call })), "rejected");
  const rows = db.actions("miniapp_button_rejected");
  assertEquals(rows.length, 1);
  assertEquals([rows[0].details.fn, rows[0].details.method], ["menu_button_live", "setChatMenuButton"]);
  _resetLiveMenuSync();
});

// Integration of #237 (☰ for every member) with #239 (teacher Mini App faults never feed the STUDENT
// watch-button watchdog): a refused STAFF menu (📝 Ustoz → /tg/teacher) is recorded under the teacher row.
Deno.test("live sync: a refused STAFF web_app menu is a teacher fault, never the student watch-button alarm", async () => {
  _resetLiveMenuSync();
  const db = new FakeDb();
  const tg = fakeTelegram(() => ({ ok: false, status: 400, error: "Bad Request: WEBAPP_URL_INVALID" }));
  assertEquals(await syncMenuLive(db, 91, opts({ call: tg.call, role: "teacher" })), "rejected");
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  const rows = db.actions("teacher_miniapp_button_rejected");
  assertEquals(rows.length, 1);
  assertEquals([rows[0].details.fn, rows[0].details.role], ["menu_button_live", "teacher"]);
  assertEquals(menuButtonAudience(menuButtonFor("admin", true, "uz", BASE)), "teacher");
  assertEquals(menuButtonAudience(menuButtonFor("student", true, "uz", BASE)), "student");
  assertEquals(menuButtonAudience({ type: "default" }), "student");
  assertEquals(menuButtonAudience({ type: "web_app", text: "x", web_app: { url: "not a url" } }), "student");
  _resetLiveMenuSync();
});

Deno.test("liveFresh: the tap path's cheap pre-check is keyed by the flag snapshot", async () => {
  _resetLiveMenuSync();
  const tg = fakeTelegram();
  const sig = flagSig(true, true, BASE);
  assertEquals(liveFresh(5, sig, T0), false);
  await syncMenuLive(new FakeDb(), 5, opts({ call: tg.call, sig }));
  assertEquals(liveFresh(5, sig, T0 + 1000), true);
  assertEquals(liveFresh(5, flagSig(false, true, BASE), T0 + 1000), false); // a flag flipped → look again
  assertEquals(liveFresh(5, sig, T0 + 3_600_001), false);
  _resetLiveMenuSync();
});

Deno.test("menuKey distinguishes role lists for staff but not for students", () => {
  const mb = menuButtonFor("teacher", true, "uz", BASE);
  assertEquals(menuKey(mb, "teacher", "uz") === menuKey(mb, "admin", "uz"), false);
  const s = menuButtonFor("student", true, "uz", BASE);
  assertEquals(menuKey(s, "student", "uz"), `web_app|🚀 Ilovani ochish|${BASE}/dashboard`);
});
