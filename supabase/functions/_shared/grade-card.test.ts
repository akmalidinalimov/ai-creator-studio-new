// Tests for the shared grade-card text. Run: deno test supabase/functions/_shared/grade-card.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GRADE_CARD, gradeCardHeading, TITLE_FALLBACK, VOICE_CAPTION } from "./grade-card.ts";

Deno.test("GRADE_CARD: the text is unchanged except for the heading (same as the bot's T.gradeStudentDM)", () => {
  // Byte-for-byte the pre-change uz card with a label where the bare title used to be.
  assertEquals(
    GRADE_CARD.uz("5.0 · 1-GURUH PRE · M2 V1 — 2-MODUL", 9, 10, "Zo'r", 25),
    "🎉 Vazifangiz baholandi!\n\n📝 <b>5.0 · 1-GURUH PRE · M2 V1 — 2-MODUL</b>\nBaho: <b>9/10</b>\n⚡ +25 XP\nIzoh: Zo'r",
  );
  assertEquals(GRADE_CARD.uz("T", 6, 10, ""), "🎉 Vazifangiz baholandi!\n\n📝 <b>T</b>\nBaho: <b>6/10</b>");
  assertEquals(GRADE_CARD.ru("T", 6, 10, "ok"), "🎉 Ваша работа оценена!\n\n📝 <b>T</b>\nОценка: <b>6/10</b>\nКомментарий: ok");
  assertEquals(GRADE_CARD.en("T", 6, 10, "", 25), "🎉 Your homework was graded!\n\n📝 <b>T</b>\nScore: <b>6/10</b>\n⚡ +25 XP");
});

Deno.test("VOICE_CAPTION carries the heading", () => {
  assertEquals(VOICE_CAPTION.uz("CH6 · 3-GURUH · M1 V1 — X"), `🎧 "CH6 · 3-GURUH · M1 V1 — X" bo'yicha yangi ovozli izoh — balingizni ko'rish uchun ilovani oching.`);
});

Deno.test("gradeCardHeading: label, else the bare title (the old text), else the generic word", () => {
  assertEquals(gradeCardHeading("CH6 · 3-GURUH · M1 V1 — X", "X", "uz"), "CH6 · 3-GURUH · M1 V1 — X");
  assertEquals(gradeCardHeading("", "  X ", "uz"), "X");
  assertEquals(gradeCardHeading(null, null, "ru"), TITLE_FALLBACK.ru);
  assertEquals(gradeCardHeading("  ", "", "en"), "Homework");
});
