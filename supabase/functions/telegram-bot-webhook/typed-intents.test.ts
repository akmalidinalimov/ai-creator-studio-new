// Pins the typed-intent rules on the real messages that got "use the buttons" in September, plus the
// conservative edges (long text, slash commands, greetings stay kbHint).
// Run: deno test supabase/functions/telegram-bot-webhook/typed-intents.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { INTENT_MAX_LEN, typedIntent } from "./typed-intents.ts";

Deno.test("the September messages that deserved a real answer", () => {
  assertEquals(typedIntent("uyga vazifa"), "/vazifalar");
  assertEquals(typedIntent("Men yana qanday vazifalarni qilmaganman"), "/vazifalar");
  assertEquals(typedIntent("Давом этамиз"), "/davom");
  assertEquals(typedIntent("Курс йук дияптику"), "/dars");
  assertEquals(typedIntent("Start"), "/start");
});

Deno.test("each intent in Latin Uzbek, Cyrillic Uzbek, Russian and English", () => {
  const cases: [string, string][] = [
    ["vazifalarim", "/vazifalar"], ["Вазифа қаерда?", "/vazifalar"], ["где задание?", "/vazifalar"],
    ["домашка", "/vazifalar"], ["homework", "/vazifalar"],
    ["davom etish", "/davom"], ["продолжить", "/davom"], ["keyingi dars", "/davom"], ["Дарс", "/davom"],
    ["урок не открывается", "/davom"], ["next lesson", "/davom"], ["darslar", "/davom"],
    ["kurs", "/dars"], ["модули курса", "/dars"], ["modullar", "/dars"],
    ["reyting", "/profil"], ["рейтинг", "/profil"], ["ballarim", "/profil"], ["Балл", "/profil"],
    ["profilim", "/profil"], ["statistika", "/profil"], ["o‘rnim qanday", "/profil"],
    ["yordam kerak", "/yordam"], ["помогите", "/yordam"], ["help", "/yordam"], ["admin bilan gaplashmoqchiman", "/yordam"],
    ["/start", ""], ["старт", "/start"], ["Menyu", "/start"], ["boshlash", "/start"],
  ];
  for (const [text, want] of cases) assertEquals(typedIntent(text) ?? "", want === "" ? "" : want, text);
});

Deno.test("priority: homework beats lesson, lesson beats course", () => {
  assertEquals(typedIntent("dars vazifasi"), "/vazifalar");
  assertEquals(typedIntent("kurs darslari"), "/davom");
});

Deno.test("left for kbHint: greetings, thanks, noise, slash commands, and long paragraphs", () => {
  for (const t of ["Salom", "rahmat", "👍", "ok", "Uchirilganku hech narsa yuq", "", "   ", "/davom", "football"]) {
    assertEquals(typedIntent(t), null, t);
  }
  assertEquals(typedIntent("vazifa ".repeat(Math.ceil(INTENT_MAX_LEN / 7) + 1)), null);
});

Deno.test("word starts only where it matters: 'ball' is not inside another word, 'dars' starts a word", () => {
  assertEquals(typedIntent("football"), null);
  assertEquals(typedIntent("sidars"), null);
});
