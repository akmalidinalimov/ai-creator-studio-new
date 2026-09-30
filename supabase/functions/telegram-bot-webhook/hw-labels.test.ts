// Run: deno test supabase/functions/telegram-bot-webhook/hw-labels.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  breakdownScopeLine,
  gradeWhoLine,
  gradingHeader,
  hwTeacherBody,
  moduleCourseMark,
  thenWho,
  withLabelLine,
  withWho,
} from "./hw-labels.ts";

const C5 = "AI CREATORS 5.0";
const C6 = "AI CREATORS CHALLENGE 6.0";

Deno.test("gradeWhoLine: names the student and the scope; nothing without a name", () => {
  assertEquals(gradeWhoLine("Aziza Karimova", "5.0 · 1-GURUH PRE · M2 V1"), "👤 <b>Aziza Karimova</b> · 5.0 · 1-GURUH PRE · M2 V1");
  assertEquals(gradeWhoLine("Aziza", ""), "👤 <b>Aziza</b>");
  assertEquals(gradeWhoLine("", "5.0"), "");
  assertEquals(gradeWhoLine(undefined, undefined), "");
  assertEquals(gradeWhoLine("<x>", "a&b"), "👤 <b>&lt;x&gt;</b> · a&amp;b");
});

Deno.test("withWho / thenWho: prompt and confirmation name the student; old sessions keep the old text", () => {
  assertEquals(withWho("Baho kiriting (0–10):", "Aziza", "CH6 · 3-GURUH · M1 V1"), "👤 <b>Aziza</b> · CH6 · 3-GURUH · M1 V1\nBaho kiriting (0–10):");
  assertEquals(thenWho("✅ Saqlandi: 9/10. Talaba xabardor qilindi.", "Aziza", "CH6 · 3-GURUH · M1 V1"),
    "✅ Saqlandi: 9/10. Talaba xabardor qilindi.\n👤 <b>Aziza</b> · CH6 · 3-GURUH · M1 V1");
  assertEquals(withWho("Izoh yozing", undefined, "x"), "Izoh yozing");
  assertEquals(thenWho("✅", null, null), "✅");
});

Deno.test("withLabelLine: appends an escaped label line, or nothing", () => {
  assertEquals(withLabelLine("🎧 O'qituvchidan ovozli izoh:", "5.0 · 1-GURUH PRE · M2 V1 — A<B"), "🎧 O'qituvchidan ovozli izoh:\n📌 5.0 · 1-GURUH PRE · M2 V1 — A&lt;B");
  assertEquals(withLabelLine("x", null), "x");
  assertEquals(withLabelLine("x", "  "), "x");
});

Deno.test("gradingHeader: label when known, else the old one-liner", () => {
  assertEquals(gradingHeader("Madina", "CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING", "unused"),
    "<b>Madina</b>\n📌 CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING");
  assertEquals(gradingHeader("Madina", "", "1- MODUL: PROMPT ENGINEERING #1"), "<b>Madina</b> — 1- MODUL: PROMPT ENGINEERING #1");
  assertEquals(gradingHeader(null, null, "T & U #2"), "<b>—</b> — T &amp; U #2");
});

Deno.test("hwTeacherBody: one label line replaces the group / module / task lines", () => {
  assertEquals(
    hwTeacherBody("Aziza (@aziza)", "5.0 · 2-GURUH VIP · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI"),
    "🆕 <b>Yangi vazifa topshirildi</b>\n👤 Talaba: <b>Aziza (@aziza)</b>\n📌 <b>5.0 · 2-GURUH VIP · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI</b>\n\nXabarni topikda ko'ring va baholang.",
  );
  assertEquals(hwTeacherBody("<s>", "").includes("<b>&lt;s&gt;</b>") && hwTeacherBody("<s>", "").includes("📌 <b>—</b>"), true);
});

Deno.test("breakdownScopeLine: course + group of the student's group", () => {
  assertEquals(breakdownScopeLine(C6, "AC CHALLENGE | 3-GURUH"), "👥 CH6 · 3-GURUH");
  assertEquals(breakdownScopeLine(C5, "1-GURUH PRE 5.0"), "👥 5.0 · 1-GURUH PRE");
  assertEquals(breakdownScopeLine(null, "1-GURUH PRE 5.0"), "👥 1-GURUH PRE 5.0");
  assertEquals(breakdownScopeLine(C5, null), "");
});

Deno.test("moduleCourseMark: only old-course work (course differs from the group's) is marked", () => {
  assertEquals(moduleCourseMark(C5, C6), " · 5.0");
  assertEquals(moduleCourseMark(C6, C6), "");
  assertEquals(moduleCourseMark(null, C6), "");
  assertEquals(moduleCourseMark(C5, null), "");
});
