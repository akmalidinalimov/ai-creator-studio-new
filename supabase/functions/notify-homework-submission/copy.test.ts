// Run: deno test supabase/functions/notify-homework-submission/copy.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isRealTopicLink, submissionDmKeyboard, submissionDmText } from "./copy.ts";

const base = { moduleNumber: 1, step: 1, title: "1- MODUL: PROMPT ENGINEERING" };

Deno.test("queued DM: a 5.0 task and its Challenge copy no longer read the same", () => {
  const a = submissionDmText("uz", "Aziza (@aziza)", { ...base, courseTitle: "AI CREATORS 5.0", groupName: "1-GURUH VIP 5.0" });
  const b = submissionDmText("uz", "Aziza (@aziza)", { ...base, courseTitle: "AI CREATORS CHALLENGE 6.0", groupName: "AC CHALLENGE | 1-GURUH" });
  assertEquals(a, "📝 <b>Yangi topshiriq</b>\n\n<b>Aziza (@aziza)</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH VIP · M1 V1 — 1- MODUL: PROMPT ENGINEERING</b>");
  assertEquals(b, "📝 <b>Yangi topshiriq</b>\n\n<b>Aziza (@aziza)</b> vazifa topshirdi:\n📌 <b>CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING</b>");
});

Deno.test("queued DM: ru / en, and user text is escaped (a raw < would make Telegram reject the message)", () => {
  const ru = submissionDmText("ru", "<b>x</b>", { ...base, courseTitle: "AI CREATORS 5.0", groupName: "G<1>", title: "a & b" });
  assert(ru.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert(ru.includes("5.0 · G&lt;1&gt; · M1 V1 — a &amp; b"));
  assert(submissionDmText("en", "S", base).includes("<b>S</b> submitted:\n📌 <b>M1 V1 — 1- MODUL: PROMPT ENGINEERING</b>"));
});

Deno.test("queued DM: a lookup that found nothing still reads like the old message", () => {
  // Course and group unknown (read failed): only the row's own snapshot remains.
  assertEquals(
    submissionDmText("uz", null, { moduleNumber: 3, step: 2, title: "3-MODUL (taxminiy)" }),
    "📝 <b>Yangi topshiriq</b>\n\n<b>—</b> vazifa topshirdi:\n📌 <b>M3 V2 — 3-MODUL (taxminiy)</b>",
  );
});

// ─────────────────────────── the keyboard (submissionDmKeyboard) ───────────────────────────
const SUB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const TOPIC = "https://t.me/c/2123456789/15/42";
const PLACEHOLDER = `https://t.me/aicreatorsdarsliklari_bot?start=hw_${SUB}_1`;

/** The keyboard exactly as index.ts built it inline before 2026-09-30 (the flag-off contract). */
function oldKeyboard(loc: "uz" | "ru" | "en", messageUrl: string, guessed: boolean) {
  const real = /^https:\/\/t\.me\/c\//.test(messageUrl || "");
  const buttons = [
    ...(real ? [{ text: loc === "ru" ? "📂 Открыть пост" : loc === "en" ? "📂 View post" : "📂 Topshirgan postni ko'rish", url: messageUrl }] : []),
    { text: loc === "ru" ? "🎯 Оценить" : loc === "en" ? "🎯 Grade" : "🎯 Baholash", callback_data: `gs:open:${SUB}` },
  ];
  const retagRow = guessed
    ? [[{ text: loc === "ru" ? "✏️ Изменить задание" : loc === "en" ? "✏️ Change task" : "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${SUB}` }]]
    : [];
  return { inline_keyboard: [buttons, ...retagRow] };
}

Deno.test("keyboard: teacher Mini App off → byte-identical to the old inline keyboard (every locale × link × guess)", () => {
  for (const loc of ["uz", "ru", "en"] as const) {
    for (const url of [TOPIC, PLACEHOLDER, ""]) {
      for (const guessed of [false, true]) {
        assertEquals(
          JSON.stringify(submissionDmKeyboard(loc, { submissionId: SUB, messageUrl: url, guessed, gradeApp: null, chatLabel: "x" })),
          JSON.stringify(oldKeyboard(loc, url, guessed)),
        );
      }
    }
  }
});

Deno.test("keyboard: Mini App on → 🎯 opens the app first; the in-chat flow is the second row", () => {
  const app = { text: "🎯 Baholash", web_app: { url: `https://www.aicreator.academy/tg/teacher/grade?sub=${SUB}&src=teacher_hw_dm&ref=${SUB}` } };
  const kb = submissionDmKeyboard("uz", { submissionId: SUB, messageUrl: TOPIC, guessed: true, gradeApp: app, chatLabel: "🎤 Chatda (ovoz bilan)" });
  assertEquals(kb.inline_keyboard, [
    [app],
    [{ text: "📂 Topshirgan postni ko'rish", url: TOPIC }, { text: "🎤 Chatda (ovoz bilan)", callback_data: `gs:open:${SUB}` }],
    [{ text: "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${SUB}` }],
  ]);
  // A Mini App submission (placeholder url): no dead "Open post" button; the app button is still first.
  const kb2 = submissionDmKeyboard("ru", { submissionId: SUB, messageUrl: PLACEHOLDER, guessed: false, gradeApp: app, chatLabel: "🎤 В чате (голосом)" });
  assertEquals(kb2.inline_keyboard, [[app], [{ text: "🎤 В чате (голосом)", callback_data: `gs:open:${SUB}` }]]);
  for (const row of kb.inline_keyboard) {
    for (const b of row) if (b.callback_data) assert(new TextEncoder().encode(b.callback_data).length <= 64);
  }
});

Deno.test("isRealTopicLink: only a t.me/c/ topic post", () => {
  assert(isRealTopicLink(TOPIC));
  assert(!isRealTopicLink(PLACEHOLDER));
  assert(!isRealTopicLink(null));
  assert(!isRealTopicLink("https://evil.example/t.me/c/1/2"));
});
