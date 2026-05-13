import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { effectiveLeafGrades, summarizeHomework, leavesFromAssignments } from "./homework-stats.ts";

Deno.test("current score wins over previous_attempts", () => {
  const out = effectiveLeafGrades(
    [{ id: "a", max_score: 10 }],
    [{ assignment_id: "a", score: 7, score_feedback: "ok", scored_at: null,
       previous_attempts: [{ score: 5 }] }],
  );
  assertEquals(out[0].effective_score, 7);
  assertEquals(out[0].effective_feedback, "ok");
});

Deno.test("falls back to latest scored previous attempt", () => {
  const out = effectiveLeafGrades(
    [{ id: "a", max_score: 10 }],
    [{ assignment_id: "a", score: null, score_feedback: null, scored_at: null,
       previous_attempts: [{ score: 8, score_feedback: "good" }, { score: null }] }],
  );
  assertEquals(out[0].effective_score, 8);
  assertEquals(out[0].effective_feedback, "good");
});

Deno.test("no submission marks unsubmitted", () => {
  const out = effectiveLeafGrades([{ id: "a", max_score: 10 }], []);
  assertEquals(out[0].submitted, false);
  assertEquals(out[0].effective_score, null);
});

Deno.test("summary aggregates correctly with mixed leaves", () => {
  const rows = effectiveLeafGrades(
    [{ id: "a", max_score: 10 }, { id: "b", max_score: 10 }, { id: "c", max_score: 10 }],
    [
      { assignment_id: "a", score: 8, score_feedback: null, scored_at: null, previous_attempts: [] },
      { assignment_id: "b", score: null, score_feedback: null, scored_at: null,
        previous_attempts: [{ score: 10 }] },
    ],
  );
  const s = summarizeHomework(rows);
  assertEquals(s.totalLeaves, 3);
  assertEquals(s.submittedCount, 2);
  assertEquals(s.scoredCount, 2);
  assertEquals(s.earned, 18);
  assertEquals(s.maxTotal, 30);
  assertEquals(s.maxScored, 20);
  assertEquals(s.avg10, 9);
});

Deno.test("leavesFromAssignments excludes parents that have SAP children", () => {
  const all = [
    { id: "p1", parent_id: null, is_active: true },
    { id: "s1", parent_id: "p1", is_active: true },
    { id: "p2", parent_id: null, is_active: true },
  ];
  const leaves = leavesFromAssignments(all);
  assertEquals(leaves.map((l) => l.id).sort(), ["p2", "s1"]);
});
