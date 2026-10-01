// Pins the 👤 Profil card: its layout per view, that tabs EDIT the tapped message (no chat flooding), that a
// repeat tap is silent success, that a gone message falls back to a new one WITHOUT a false web_app alarm, and
// that a refused web_app button is re-sent once with the magic links.
// Run: deno test supabase/functions/telegram-bot-webhook/profile-tabs.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Cell, langChooserKeyboard, parseProfAction, profileRows, profileWebCells, type ProfLabels, showProfileView } from "./profile-tabs.ts";
import { _resetStudentMiniAppFlagCache } from "../_shared/miniapp-button.ts";
import { FakeDb, type Row } from "../_bot/testing/fake-db.ts";
import { type SendOutcome } from "../_shared/telegram-send.ts";

const L: ProfLabels = {
  card: "👤 Profil", stats: "📊 Statistika", badges: "🏆 Yutuqlarim", group: "👥 Guruh reytingi",
  settings: "⚙️ Sozlamalar", editName: "✏️ Ismni o'zgartirish", lang: "🌐 Til",
};
const WEB: [Cell, Cell] = [
  { text: "🏆 To'liq reyting", web_app: { url: "https://www.aicreator.academy/leaderboard?src=bot_profile" } },
  { text: "👤 Profilni ochish", web_app: { url: "https://www.aicreator.academy/profile?src=bot_profile" } },
];
const cb = (rows: Cell[][]) => rows.flat().map((c) => (c as Row).callback_data ?? (c as Row).web_app?.url ?? (c as Row).url);

Deno.test("parseProfAction: tabs and home edit in place; card (from other messages) posts new; others are not views", () => {
  assertEquals(parseProfAction("stats"), { view: "stats", edit: true });
  assertEquals(parseProfAction("badges"), { view: "badges", edit: true });
  assertEquals(parseProfAction("group"), { view: "group", edit: true });
  assertEquals(parseProfAction("home"), { view: "card", edit: true });
  assertEquals(parseProfAction("card"), { view: "card", edit: false });
  assertEquals(parseProfAction("settings"), null);
  assertEquals(parseProfAction("lang"), null);
});

Deno.test("the card: today's buttons + To'liq reyting ↗ + 🌐 Til; every callback fits Telegram's 64 bytes", () => {
  const rows = profileRows("card", L, WEB);
  assertEquals(cb(rows), [
    "prof:stats", "prof:badges", "prof:group", "prof:settings",
    WEB[0] && (WEB[0] as Row).web_app.url, (WEB[1] as Row).web_app.url,
    "name:edit", "prof:lang",
  ]);
  for (const c of rows.flat()) {
    const d = (c as Row).callback_data;
    if (d) assert(new TextEncoder().encode(d).length <= 64, d);
  }
});

Deno.test("a tab view: back to the card + the two OTHER tabs (never itself), then the ↗ row", () => {
  assertEquals(cb(profileRows("stats", L, WEB)).slice(0, 3), ["prof:home", "prof:badges", "prof:group"]);
  assertEquals(cb(profileRows("badges", L, WEB)).slice(0, 3), ["prof:home", "prof:stats", "prof:group"]);
  assertEquals(cb(profileRows("group", L, WEB)).slice(0, 3), ["prof:home", "prof:stats", "prof:badges"]);
  assertEquals(profileRows("group", L, WEB)[1], WEB);
});

Deno.test("the ↗ buttons are Mini App web_app buttons (src bot_profile) when the student Mini App is on", async () => {
  _resetStudentMiniAppFlagCache();
  const admin = new FakeDb({ platform_settings: [{ key: "student_miniapp", value: { enabled: true } }] });
  const minted: string[] = [];
  const [rating, open] = await profileWebCells(admin, {
    chatId: 555, locale: "uz", openLabel: "👤 Profilni ochish", webhookOn: true,
    magicLink: (p) => { minted.push(p); return Promise.resolve(`https://x/auth/magic?t=${p}`); },
  });
  assertEquals(rating.button, { text: "🏆 To'liq reyting", web_app: { url: "https://www.aicreator.academy/leaderboard?src=bot_profile" } });
  assertEquals(open.button, { text: "👤 Profilni ochish", web_app: { url: "https://www.aicreator.academy/profile?src=bot_profile" } });
  assertEquals(minted, []);
  // off → today's magic links, to the same pages
  const [r2, o2] = await profileWebCells(admin, {
    chatId: 555, locale: "ru", openLabel: "👤 Открыть профиль", webhookOn: false,
    magicLink: (p) => { minted.push(p); return Promise.resolve(`https://x/auth/magic?t=${p}`); },
  });
  assertEquals([r2.mode, o2.mode], ["magic_link", "magic_link"]);
  assertEquals(minted, ["/leaderboard", "/profile"]);
  assertEquals((r2.button as Row).text, "🏆 Весь рейтинг");
  _resetStudentMiniAppFlagCache();
});

const ok = { ok: true, status: 200, error: null, terminal: false, recipient: false, content: false };
const bad = (error: string, status = 400) => ({ ok: false, status, error, terminal: false, recipient: false, content: false });

function spy(editAnswers: SendOutcome[]) {
  const edits: Row[] = [];
  const sends: Row[] = [];
  return {
    edits, sends,
    editFn: (p: Record<string, unknown>) => { edits.push(p); return Promise.resolve(editAnswers.shift() ?? ok); },
    sendFn: (_a: unknown, chatId: number, text: string, rows: Cell[][]) => { sends.push({ chatId, text, rows }); return Promise.resolve(ok); },
  };
}

Deno.test("a tab tap edits the SAME message (no new message)", async () => {
  const s = spy([ok]);
  const r = await showProfileView(new FakeDb(), { chatId: 9, messageId: 42, edit: true, text: "📊 <b>Statistika</b>", rows: profileRows("stats", L, WEB), editFn: s.editFn, sendFn: s.sendFn });
  assertEquals(r, "edited");
  assertEquals(s.sends.length, 0);
  assertEquals([s.edits[0].chat_id, s.edits[0].message_id, s.edits[0].parse_mode], [9, 42, "HTML"]);
  assertEquals(((s.edits[0].reply_markup as Row).inline_keyboard as Row[][])[0][0].callback_data, "prof:home");
});

Deno.test("a repeat tap ('message is not modified') is silent success: no new message, no alarm", async () => {
  const db = new FakeDb();
  const s = spy([bad("Bad Request: message is not modified: specified new message content and reply markup are exactly the same")]);
  const r = await showProfileView(db, { chatId: 9, messageId: 42, edit: true, text: "x", rows: profileRows("card", L, WEB), editFn: s.editFn, sendFn: s.sendFn });
  assertEquals(r, "unchanged");
  assertEquals([s.edits.length, s.sends.length], [1, 0]);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
});

Deno.test("a gone message falls back to a NEW message — and is not mistaken for a web_app rejection", async () => {
  const db = new FakeDb();
  const s = spy([bad("Bad Request: message to edit not found")]);
  const r = await showProfileView(db, { chatId: 9, messageId: 42, edit: true, text: "x", rows: profileRows("card", L, WEB), editFn: s.editFn, sendFn: s.sendFn });
  assertEquals(r, "sent");
  assertEquals([s.edits.length, s.sends.length], [1, 1]);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
});

Deno.test("a refused web_app button is re-sent once with today's magic links (and alarmed)", async () => {
  const db = new FakeDb();
  const s = spy([bad("Bad Request: BUTTON_TYPE_INVALID"), ok]);
  const watch = (text: string, path: string) => ({
    button: { text, web_app: { url: `https://www.aicreator.academy${path}` } },
    mode: "web_app" as const,
    legacy: () => Promise.resolve({ text, url: `https://ai-creator-studio-new.vercel.app/auth/magic?t=${path.slice(1)}` }),
  });
  const rows = profileRows("stats", L, [watch("🏆 To'liq reyting", "/leaderboard"), watch("👤 Profilni ochish", "/profile")]);
  const r = await showProfileView(db, { chatId: 9, messageId: 42, edit: true, text: "x", rows, editFn: s.editFn, sendFn: s.sendFn });
  assertEquals(r, "edited");
  assertEquals(s.edits.length, 2);
  const second = ((s.edits[1].reply_markup as Row).inline_keyboard as Row[][])[1];
  assertEquals(second.map((b) => b.url), ["https://ai-creator-studio-new.vercel.app/auth/magic?t=leaderboard", "https://ai-creator-studio-new.vercel.app/auth/magic?t=profile"]);
  assertEquals(db.actions("miniapp_button_rejected").length, 1);
});

Deno.test("prof:card (edit=false) posts a new card; the language chooser is the /til one", async () => {
  const s = spy([]);
  assertEquals(await showProfileView(new FakeDb(), { chatId: 9, messageId: 42, edit: false, text: "x", rows: [], editFn: s.editFn, sendFn: s.sendFn }), "sent");
  assertEquals([s.edits.length, s.sends.length], [0, 1]);
  assertEquals(langChooserKeyboard().inline_keyboard[0].map((b) => b.callback_data), ["setlang:uz", "setlang:ru", "setlang:en"]);
});
