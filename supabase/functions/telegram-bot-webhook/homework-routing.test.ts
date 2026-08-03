import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AssignmentRow,
  computeLeaves,
  displayStepNumber,
  pickNextLeaf,
  type SubmissionRow,
} from "./homework-routing.ts";

// Test fixture builders ----------------------------------------------------
const parent = (id: string, tn: number, extra: Partial<AssignmentRow> = {}): AssignmentRow => ({
  id, task_number: tn, sap_number: null, parent_id: null, is_active: true, ...extra,
});
const sap = (
  id: string,
  parentId: string,
  tn: number,
  sn: number,
  extra: Partial<AssignmentRow> = {},
): AssignmentRow => ({
  id, task_number: tn, sap_number: sn, parent_id: parentId, is_active: true, ...extra,
});
const sub = (assignment_id: string, score: number | null): SubmissionRow => ({
  assignment_id, score,
});

// 1. Single standalone parent ---------------------------------------------
Deno.test("standalone parent (no SAPs) routes to itself", () => {
  const all = [parent("v1", 1)];
  const leaves = computeLeaves(all);
  assertEquals(leaves.map((l) => l.id), ["v1"]);
  assertEquals(pickNextLeaf(leaves, [])?.id, "v1");
});

// 2. Parent with 3 SAPs, no submissions -----------------------------------
Deno.test("parent with SAPs routes to S1 first", () => {
  const all = [
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
    sap("v1s3", "v1", 1, 3),
  ];
  const leaves = computeLeaves(all);
  assertEquals(leaves.map((l) => l.id), ["v1s1", "v1s2", "v1s3"]);
  assertEquals(pickNextLeaf(leaves, [])?.id, "v1s1");
});

// 3. S1 graded, S2 ungraded -> route to S2 --------------------------------
Deno.test("S1 graded -> next is S2", () => {
  const leaves = computeLeaves([
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
  ]);
  const next = pickNextLeaf(leaves, [sub("v1s1", 8)]);
  assertEquals(next?.id, "v1s2");
});

// 4. S1 submitted but pending grade -> still route to S1 ------------------
Deno.test("submitted but ungraded leaf is still 'next'", () => {
  const leaves = computeLeaves([
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
  ]);
  const next = pickNextLeaf(leaves, [sub("v1s1", null)]);
  assertEquals(next?.id, "v1s1");
});

// 5. V1 fully graded, V2 standalone untouched -> V2 -----------------------
Deno.test("V1 fully graded -> next is V2 standalone", () => {
  const leaves = computeLeaves([
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
    parent("v2", 2),
  ]);
  assertEquals(leaves.map((l) => l.id), ["v1s1", "v1s2", "v2"]);
  const next = pickNextLeaf(leaves, [sub("v1s1", 9), sub("v1s2", 10)]);
  assertEquals(next?.id, "v2");
});

// 6. Everything graded -> fall back to last leaf --------------------------
Deno.test("all graded -> falls back to last leaf", () => {
  const leaves = computeLeaves([
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
  ]);
  const next = pickNextLeaf(leaves, [sub("v1s1", 7), sub("v1s2", 8)]);
  assertEquals(next?.id, "v1s2");
});

// 7. Mixed module ordering ------------------------------------------------
Deno.test("mixed parents: leaves are V1.S1, V1.S2, V2 in order", () => {
  // Intentionally shuffled input order
  const leaves = computeLeaves([
    parent("v2", 2),
    sap("v1s2", "v1", 1, 2),
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
  ]);
  assertEquals(leaves.map((l) => l.id), ["v1s1", "v1s2", "v2"]);
  assertEquals(pickNextLeaf(leaves, [])?.id, "v1s1");
});

// 8. Inactive rows excluded ----------------------------------------------
Deno.test("inactive assignments are filtered out", () => {
  const leaves = computeLeaves([
    parent("v1", 1, { is_active: false }),
    parent("v2", 2),
  ]);
  assertEquals(leaves.map((l) => l.id), ["v2"]);
});

// 9. Per-student isolation -----------------------------------------------
Deno.test("two students with different submission states get different leaves", () => {
  const leaves = computeLeaves([
    parent("v1", 1),
    sap("v1s1", "v1", 1, 1),
    sap("v1s2", "v1", 1, 2),
    sap("v1s3", "v1", 1, 3),
  ]);
  const studentA = pickNextLeaf(leaves, [sub("v1s1", 9)]); // S1 graded -> S2
  const studentB = pickNextLeaf(leaves, []);               // nothing yet -> S1
  const studentC = pickNextLeaf(leaves, [                  // S1+S2 graded -> S3
    sub("v1s1", 9), sub("v1s2", 10),
  ]);
  assertEquals(studentA?.id, "v1s2");
  assertEquals(studentB?.id, "v1s1");
  assertEquals(studentC?.id, "v1s3");
});

// 10. Empty input --------------------------------------------------------
Deno.test("empty leaves -> null", () => {
  assertEquals(pickNextLeaf([], []), null);
  assertEquals(pickNextLeaf(computeLeaves([]), []), null);
});

// 11. displayStepNumber: SAP sub-step shows sap_number, not the parent's task_number -------
Deno.test("displayStepNumber: SAP leaf shows its sap_number", () => {
  // The reported bug: Module-3 SAP steps all share task_number=3; the human step is sap_number.
  assertEquals(displayStepNumber(sap("v3s1", "v3", 3, 1)), 1);
  assertEquals(displayStepNumber(sap("v3s2", "v3", 3, 2)), 2);
  assertEquals(displayStepNumber(sap("v3s3", "v3", 3, 3)), 3);
});

Deno.test("displayStepNumber: normal task shows task_number (unchanged)", () => {
  assertEquals(displayStepNumber(parent("v1", 1)), 1);
  assertEquals(displayStepNumber(parent("v2", 2)), 2);
});

Deno.test("displayStepNumber: null-safe defaults", () => {
  // SAP leaf missing sap_number -> falls back to task_number, then 1.
  assertEquals(displayStepNumber({ parent_id: "p", task_number: 3, sap_number: null }), 3);
  assertEquals(displayStepNumber({ parent_id: "p", task_number: null, sap_number: null }), 1);
  assertEquals(displayStepNumber({ parent_id: null, task_number: null, sap_number: null }), 1);
});

// 12. computeLeaves is deterministic across fetch order when sort keys collide ------------
Deno.test("computeLeaves: stable id tiebreak when (task_number, sap_number) collide", () => {
  // Two leaves sharing (task=1, sap=1) — the picker/retag resolve leaves[index], so the order
  // MUST be identical no matter what order the DB returned the rows in.
  const forward = computeLeaves([sap("a", "v1", 1, 1), sap("b", "v1", 1, 1)]);
  const reverse = computeLeaves([sap("b", "v1", 1, 1), sap("a", "v1", 1, 1)]);
  assertEquals(forward.map((l) => l.id), ["a", "b"]);
  assertEquals(reverse.map((l) => l.id), ["a", "b"]);
});
