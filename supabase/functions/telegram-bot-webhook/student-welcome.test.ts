// Pins the student /start welcome: what it says (name, course · group, the CURRENT keyboard's labels, the ☰
// app door only when the Mini App is on, where homework goes), that message 1 carries the reply keyboard, and
// that message 2 has the right buttons for a normal student, a finished course, a trial account and no group.
// Run: deno test supabase/functions/telegram-bot-webhook/student-welcome.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendStudentWelcome, WELCOME_T, welcomeText } from "./student-welcome.ts";
import { FakeDb, type Row } from "../_bot/testing/fake-db.ts";

const LABELS = { davom: "📚 Davom etish", homework: "📝 Mening vazifalarim", profil: "👤 Profil" };
const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const G = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const TOPIC = "https://t.me/c/2345678901/12";

Deno.test("welcomeText (uz): greeting, course · group, the keyboard's own labels, ☰ door, homework topic", () => {
  const t = welcomeText("uz", { name: "Aziza", course: "AI CREATORS 5.0", group: "3-guruh", appOn: true, trial: false, labels: LABELS });
  assertEquals(t.split("\n"), [
    "Salom, <b>Aziza</b>! 👋",
    "Siz <b>AI CREATORS 5.0 · 3-guruh</b> talabasisiz.",
    "",
    "📚 Davom etish — keyingi darsingiz",
    "📝 Mening vazifalarim — nima topshirildi, nima qoldi",
    "👤 Profil — ballaringiz va guruhdagi o'rningiz",
    "🚀 Hammasi bitta ilovada — pastda chapdagi ☰ «Ilovani ochish» tugmasi.",
    "",
    "📥 Uy vazifasini (video, rasm, fayl) guruhdagi «UYGA VAZIFA» topigiga yuborasiz.",
  ]);
});

Deno.test("welcomeText: no ☰ line when the Mini App is off; a trial account has no lesson line; names are escaped", () => {
  const off = welcomeText("uz", { name: "A", course: null, group: null, appOn: false, trial: false, labels: LABELS });
  assert(!off.includes("☰"));
  assert(!off.includes("talabasisiz"), "no course/group line without a group");
  const trial = welcomeText("ru", { name: "<b>x</b>", course: "C", group: "G", appOn: true, trial: true, labels: LABELS });
  assert(!trial.includes("📚 Davom etish"));
  assert(trial.includes(WELCOME_T.ru.trial));
  assert(trial.includes("&lt;b&gt;x&lt;/b&gt;"));
  assertEquals(welcomeText("en", { name: "  ", course: null, group: null, appOn: false, trial: false, labels: LABELS }).split("\n")[0], "Hi, <b>👋</b>! 👋");
});

function run(o: { account_type?: string; group?: Row | null; course?: string | null; next?: string | null; appOn?: boolean }) {
  const db = new FakeDb({
    groups: o.group === null ? [] : [{ id: G, name: "3-guruh", course_id: C, homework_topic_url: TOPIC, ...(o.group ?? {}) }],
    courses: [{ id: C, title: "AI CREATORS 5.0" }],
  });
  const keyboardTexts: string[] = [];
  const sends: { text: string; rows: Row[][] }[] = [];
  const watches: Row[] = [];
  const p = sendStudentWelcome(db, {
    chatId: 555, locale: "uz",
    profile: { id: "u1", name: "Aziza", group_id: o.group === null ? null : G, account_type: o.account_type ?? "paid" },
    labels: LABELS, appOn: o.appOn ?? true,
    sendWithKeyboard: (text) => { keyboardTexts.push(text); return Promise.resolve(); },
    primaryCourseId: () => Promise.resolve(o.course === undefined ? C : o.course),
    nextLessonId: () => Promise.resolve(o.next === undefined ? "L1" : o.next),
    watch: (w) => {
      watches.push(w);
      return Promise.resolve({ button: { text: w.text, web_app: { url: `https://www.aicreator.academy${w.miniPath}` } }, mode: "web_app" as const, legacy: () => Promise.resolve(null) });
    },
    sendFn: (_a, _c, text, rows) => {
      sends.push({ text, rows: rows.map((r) => r.map((c) => ("legacy" in c ? (c as Row).button : c) as Row)) });
      return Promise.resolve({ ok: true, status: 200, error: null, terminal: false, recipient: false, content: false });
    },
  });
  return p.then(() => ({ keyboardTexts, sends, watches }));
}

Deno.test("a student: message 1 on the keyboard, then ▶️ Keyingi dars (Mini App /continue/<course>) + the homework topic", async () => {
  const r = await run({});
  assertEquals(r.keyboardTexts.length, 1);
  assert(r.keyboardTexts[0].includes("AI CREATORS 5.0 · 3-guruh"));
  assertEquals(r.sends.length, 1);
  assertEquals(r.sends[0].text, WELCOME_T.uz.cta);
  assertEquals(r.sends[0].rows, [
    [{ text: "▶️ Keyingi dars", web_app: { url: `https://www.aicreator.academy/continue/${C}` } }],
    [{ text: "📥 UYGA VAZIFA topigi", url: TOPIC }],
  ]);
  assertEquals(r.watches[0].legacyPath, `/lesson/${C}/L1`);
});

Deno.test("a finished course: the course page instead of a lesson", async () => {
  const r = await run({ next: null });
  assertEquals(r.sends[0].rows[0][0].text, "📋 Kurs sahifasi");
  assertEquals(r.watches[0].miniPath, `/course/${C}`);
});

Deno.test("a trial account: no lesson button, only the topic", async () => {
  const r = await run({ account_type: "provisional" });
  assertEquals(r.watches.length, 0);
  assertEquals(r.sends[0].text, WELCOME_T.uz.ctaTopicOnly);
  assertEquals(r.sends[0].rows, [[{ text: "📥 UYGA VAZIFA topigi", url: TOPIC }]]);
});

Deno.test("no group and no course: the welcome only (no empty button message); a non-t.me topic is never linked", async () => {
  const r = await run({ group: null, course: null });
  assertEquals([r.keyboardTexts.length, r.sends.length], [1, 0]);
  const r2 = await run({ group: { homework_topic_url: "javascript:alert(1)" } });
  assertEquals(r2.sends[0].rows.length, 1);
});

Deno.test("welcomeText: with the 📸 Instagram qo‘shish button the third line describes it instead of 👤 Profil", () => {
  const t = welcomeText("uz", {
    name: "Aziza", course: "C", group: "G", appOn: false, trial: false,
    labels: { ...LABELS, instagram: "📸 Instagram qo‘shish" },
  });
  assert(t.includes("📸 Instagram qo‘shish — Instagram username’ingizni qo‘shish yoki o‘zgartirish"));
  assert(!t.includes(`${LABELS.profil} —`));
  // without it: the old line, unchanged
  const old = welcomeText("uz", { name: "Aziza", course: "C", group: "G", appOn: false, trial: false, labels: LABELS });
  assert(old.includes(`${LABELS.profil} — ${WELCOME_T.uz.profil}`));
});
