// Tests for the shared homework label. Run: deno test supabase/functions/_shared/hw-label.test.ts
// The fixtures are the live prod course and group names (2026-09-30).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { courseShort, courseVersion, groupShort, hwLabel, scopeTag, stepOf, taskTag } from "./hw-label.ts";
import { displayStepNumber } from "../telegram-bot-webhook/homework-routing.ts";

const C5 = "AI CREATORS 5.0";
const C6 = "AI CREATORS CHALLENGE 6.0";
const C4 = "AI CREATORS 4.0";

Deno.test("courseShort: the live course titles", () => {
  assertEquals(courseShort(C5), "5.0");
  assertEquals(courseShort(C6), "CH6");
  assertEquals(courseShort(C4), "4.0");
});

Deno.test("courseShort: challenge minor versions, case, whitespace", () => {
  assertEquals(courseShort("AI Creators Challenge 6.5"), "CH6.5");
  assertEquals(courseShort("  ai creators   challenge 7.0 "), "CH7");
  assertEquals(courseShort("CHALLENGE"), "CH");
  assertEquals(courseShort("AI CREATORS 5,0"), "5.0");
});

Deno.test("courseShort: no version → the title clipped; nothing → empty", () => {
  assertEquals(courseShort("Midjourney"), "Midjourney");
  assertEquals(courseShort("Midjourney masterclass pro"), "Midjourney ma…");
  assertEquals(courseShort(null), "");
  assertEquals(courseShort(undefined), "");
  assertEquals(courseShort("   "), "");
});

Deno.test("courseShort: 'challenge' must be a word, not a substring", () => {
  assertEquals(courseShort("Challenges 2.0"), "2.0");
});

Deno.test("courseVersion: the last number in the title", () => {
  assertEquals(courseVersion("AI CREATORS 2026 5.0"), "5.0");
  assertEquals(courseVersion("no digits"), "");
});

Deno.test("groupShort: drops only the markers the course short already shows", () => {
  assertEquals(groupShort("1-GURUH PRE 5.0", C5), "1-GURUH PRE");
  assertEquals(groupShort("1-GURUH VIP 5.0", C5), "1-GURUH VIP");
  assertEquals(groupShort("2-GURUH VIP 5.0", C5), "2-GURUH VIP");
  for (let n = 1; n <= 6; n++) assertEquals(groupShort(`AC CHALLENGE | ${n}-GURUH`, C6), `${n}-GURUH`);
});

Deno.test("groupShort: a group of ANOTHER course keeps its whole name (a moved student's mismatch shows)", () => {
  assertEquals(groupShort("AC CHALLENGE | 3-GURUH", C5), "AC CHALLENGE | 3-GURUH");
  assertEquals(groupShort("2-GURUH VIP 5.0", C6), "2-GURUH VIP 5.0");
  assertEquals(groupShort("1-GURUH PRE 5.0", C4), "1-GURUH PRE 5.0");
});

Deno.test("groupShort: no course → unchanged; never empty; a bare number is not treated as the version", () => {
  assertEquals(groupShort("1-GURUH PRE 5.0", null), "1-GURUH PRE 5.0");
  assertEquals(groupShort("5.0", C5), "5.0"); // stripping would leave nothing
  assertEquals(groupShort("GURUH 5", "AI CREATORS 5"), "GURUH 5");
  assertEquals(groupShort("15.0 GURUH", C5), "15.0 GURUH"); // "5.0" inside "15.0" is not a token
  assertEquals(groupShort(null, C5), "");
  assertEquals(groupShort("  1-GURUH   PRE  5.0 ", C5), "1-GURUH PRE");
});

Deno.test("stepOf: identical to the bot's displayStepNumber for every shape", () => {
  const shapes = [
    { parent_id: null, task_number: 3, sap_number: null },
    { parent_id: null, task_number: null, sap_number: null },
    { parent_id: "p", task_number: 3, sap_number: 2 },
    { parent_id: "p", task_number: 3, sap_number: null },
    { parent_id: "p", task_number: null, sap_number: null },
    { parent_id: null, task_number: 4, sap_number: 1 },
  ];
  for (const s of shapes) assertEquals(stepOf(s), displayStepNumber(s), JSON.stringify(s));
  assertEquals(stepOf(null), null);
});

Deno.test("taskTag: parts left out cleanly", () => {
  assertEquals(taskTag(2, 1), "M2 V1");
  assertEquals(taskTag(2, null), "M2");
  assertEquals(taskTag(null, 3), "V3");
  assertEquals(taskTag(null, null), "");
  assertEquals(taskTag(Number.NaN, -1), "");
});

Deno.test("scopeTag: the card chip", () => {
  assertEquals(scopeTag(C5, "2-GURUH VIP 5.0"), "5.0 · 2-GURUH VIP");
  assertEquals(scopeTag(C6, "AC CHALLENGE | 3-GURUH"), "CH6 · 3-GURUH");
  assertEquals(scopeTag(null, "2-GURUH VIP 5.0"), "2-GURUH VIP 5.0");
  assertEquals(scopeTag(C6, null), "CH6");
  assertEquals(scopeTag(null, null), "");
});

Deno.test("hwLabel: the same cloned task reads differently per course", () => {
  const title = "1- MODUL: PROMPT ENGINEERING";
  const a = hwLabel({ courseTitle: C5, groupName: "1-GURUH VIP 5.0", moduleNumber: 1, step: 1, title });
  const b = hwLabel({ courseTitle: C6, groupName: "AC CHALLENGE | 1-GURUH", moduleNumber: 1, step: 1, title });
  assertEquals(a, "5.0 · 1-GURUH VIP · M1 V1 — 1- MODUL: PROMPT ENGINEERING");
  assertEquals(b, "CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING");
});

Deno.test("hwLabel: moved student — task course and group course disagree, both stay visible", () => {
  assertEquals(
    hwLabel({ courseTitle: C5, groupName: "AC CHALLENGE | 3-GURUH", moduleNumber: 2, step: 1, title: "2-MODUL ERKAKLAR KO'Z OYNAGI" }),
    "5.0 · AC CHALLENGE | 3-GURUH · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI",
  );
});

Deno.test("hwLabel: missing parts degrade to the old text, never to stray separators", () => {
  assertEquals(hwLabel({ title: "Task" }), "Task");
  assertEquals(hwLabel({ moduleNumber: 2, step: 1, title: "Task" }), "M2 V1 — Task");
  assertEquals(hwLabel({ courseTitle: C5, groupName: "1-GURUH PRE 5.0", moduleNumber: 2, step: 1 }), "5.0 · 1-GURUH PRE · M2 V1");
  assertEquals(hwLabel({ courseTitle: C5, title: "  " }), "5.0");
  assertEquals(hwLabel({}), "");
});

Deno.test("hwLabel: the '(taxminiy)' guessed-task marker in a title survives", () => {
  const l = hwLabel({ courseTitle: C5, groupName: "1-GURUH PRE 5.0", moduleNumber: 3, step: 2, title: "3-MODUL (taxminiy)" });
  assertEquals(/\(taxminiy\)/.test(l), true);
});
