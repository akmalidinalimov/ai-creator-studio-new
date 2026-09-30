// Run: deno test supabase/functions/notify-homework-submission/copy.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { submissionDmText } from "./copy.ts";

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
