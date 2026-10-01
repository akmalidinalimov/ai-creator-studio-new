import { describe, it, expect } from "vitest";

// ONE new-homework DM text, in SQL and TypeScript. Migration 20260930182000 gives the SQL fallback deliverer
// (hw_dm_fallback_deliver) public.hw_submission_dm_text_uz(), the SQL twin of the drainer's
// submissionDmText('uz', ...) (notify-homework-submission/copy.ts, built on the shared hw-label). The migration
// carries parity cases, each with the exact text TypeScript produces ("want"); at apply time it asserts
// SQL = want for every case, and this test asserts TypeScript = want. So a later edit to either side — the label
// rules, the Uzbek wording, the escaping — fails CI or the deploy instead of making the two DMs drift apart.
// (The PGlite harness supabase/functions/_teacher/testing/grading-queue-filter-check.ts also fuzzes both.)
import { submissionDmText } from "../../supabase/functions/notify-homework-submission/copy";
import migration from "../../supabase/migrations/20260930182000_grading_queue_course_filter.sql?raw";

interface Case {
  name: string | null;
  course: string | null;
  group: string | null;
  m: number | null;
  s: number | null;
  title: string | null;
  want: string;
}

const src = migration.replace(/\r\n/g, "\n");
const block = src.split("-- parity-cases:begin")[1]?.split("-- parity-cases:end")[0] ?? "";
const json = block.split("$cases$")[1] ?? "";
const cases: Case[] = JSON.parse(json);

describe("hw_submission_dm_text_uz (SQL) = submissionDmText('uz') (TypeScript)", () => {
  it("the migration carries its parity cases, covering the live names, a moved student, escaping and odd input", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    const all = JSON.stringify(cases);
    for (const needle of ["AI CREATORS 5.0", "AI CREATORS CHALLENGE 6.0", "AC CHALLENGE | 3-GURUH", "&lt;", "(taxminiy)", "\\t"]) {
      expect(all).toContain(needle);
    }
  });

  it("TypeScript produces every case's text exactly", () => {
    const bad = cases.filter(
      (c) => submissionDmText("uz", c.name, { courseTitle: c.course, groupName: c.group, moduleNumber: c.m, step: c.s, title: c.title }) !== c.want,
    );
    expect(bad).toEqual([]);
  });

  it("the migration asserts the SQL side against the same cases before it commits", () => {
    expect(src).toContain("_got := public.hw_submission_dm_text_uz(_c->>'name', _c->>'course', _c->>'group',");
    expect(src).toContain("if _got is distinct from _c->>'want' then");
  });
});
