// Tests for the per-group lines under teacher digest/nudge counts. Run: deno test supabase/functions/_shared/teacher-group-lines.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { countLines, countPayload, groupLabel, MAX_GROUP_LINES, rowsByTeacher, type TeacherGroupRow } from "./teacher-group-lines.ts";

const C5 = "AI CREATORS 5.0";
const C6 = "AI CREATORS CHALLENGE 6.0";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const row = (t: string, g: string, name: string, course: string | null, pending = 0, waiting = 0): TeacherGroupRow =>
  ({ teacher_id: t, group_id: g, group_name: name, course_title: course, pending_homework: pending, waiting_questions: waiting });

Deno.test("label: course short + group without the repeated course marker", () => {
  assertEquals(groupLabel(C5, "1-GURUH PRE 5.0"), "5.0 · 1-GURUH PRE");
  assertEquals(groupLabel(C6, "AC CHALLENGE | 3-GURUH"), "CH6 · 3-GURUH");
});

Deno.test("label: no course -> the group name; nothing at all -> a dash", () => {
  assertEquals(groupLabel(null, "  Yangi   guruh "), "Yangi guruh");
  assertEquals(groupLabel(null, null), "—");
});

Deno.test("lines: one per group with a count, board order (course, then group), zero groups left out", () => {
  const rows = [
    row("t", "g3", "AC CHALLENGE | 3-GURUH", C6, 2),
    row("t", "g1", "2-GURUH VIP 5.0", C5, 0),
    row("t", "g2", "1-GURUH PRE 5.0", C5, 3),
  ];
  assertEquals(countLines(rows, (r) => r.pending_homework, { esc, loc: "uz" }), [
    "   • 5.0 · 1-GURUH PRE — 3",
    "   • CH6 · 3-GURUH — 2",
  ]);
});

Deno.test("lines: nothing waiting anywhere -> no lines (the total prints alone, as before)", () => {
  assertEquals(countLines([row("t", "g", "1-GURUH PRE 5.0", C5, 0)], (r) => r.pending_homework, { esc, loc: "uz" }), []);
  assertEquals(countLines(null, (r) => r.pending_homework, { esc, loc: "uz" }), []);
});

Deno.test("lines: the label is escaped for HTML (a group name is admin-typed)", () => {
  assertEquals(countLines([row("t", "g", "A<b>&", null, 1)], (r) => r.pending_homework, { esc, loc: "en" }),
    ["   • A&lt;b&gt;&amp; — 1"]);
});

Deno.test("lines: the waiting count is picked independently of the pending one", () => {
  const rows = [row("t", "g1", "1-GURUH PRE 5.0", C5, 3, 0), row("t", "g2", "2-GURUH VIP 5.0", C5, 0, 2)];
  assertEquals(countLines(rows, (r) => r.waiting_questions, { esc, loc: "ru" }), ["   • 5.0 · 2-GURUH VIP — 2"]);
});

Deno.test("lines: more groups than the cap fold into one localized '… +N' line, total line count = cap", () => {
  const rows = Array.from({ length: MAX_GROUP_LINES + 3 }, (_, i) => row("t", `g${i}`, `${i + 1}-GURUH`, C5, 1));
  for (const loc of ["uz", "ru", "en"] as const) {
    const out = countLines(rows, (r) => r.pending_homework, { esc, loc });
    assertEquals(out.length, MAX_GROUP_LINES);
    assertEquals(out[out.length - 1].includes("4"), true, out[out.length - 1]);
  }
  assertEquals(countLines(rows, (r) => r.pending_homework, { esc, loc: "uz" }).at(-1), "   • … yana 4 ta guruh");
});

Deno.test("lines: junk counts (null, negative, NaN, string) read as 0; fractions are truncated", () => {
  const junk = (g: string, v: unknown): TeacherGroupRow =>
    ({ ...row("t", g, g.toUpperCase(), null), pending_homework: v as number });
  const rows = [junk("a", null), junk("b", -2), junk("c", "x"), junk("d", "2.7")];
  assertEquals(countLines(rows, (r) => r.pending_homework, { esc, loc: "en" }), ["   • D — 2"]);
});

Deno.test("rowsByTeacher: groups by teacher, sorted, drops rows without ids", () => {
  const m = rowsByTeacher([
    row("t1", "g2", "AC CHALLENGE | 1-GURUH", C6, 1),
    row("t2", "g1", "1-GURUH PRE 5.0", C5, 1),
    row("t1", "g1", "1-GURUH PRE 5.0", C5, 1),
    { ...row("", "g9", "X", null, 1) },
    { ...row("t1", "", "Y", null, 1) },
  ]);
  assertEquals([...m.keys()].sort(), ["t1", "t2"]);
  assertEquals(m.get("t1")!.map((r) => r.group_id), ["g1", "g2"]);
});

Deno.test("countPayload: only groups with something, as {group_id, n}", () => {
  assertEquals(countPayload([row("t", "g1", "A", null, 2), row("t", "g2", "B", null, 0)], (r) => r.pending_homework),
    [{ group_id: "g1", n: 2 }]);
});
