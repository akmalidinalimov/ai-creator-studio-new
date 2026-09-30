// Run: deno test supabase/functions/admin-create-students/move-row.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dbRefusalFacts, emptyFacts } from "../_shared/course-move-guard.ts";
import { dbRefusedMoveRow, refusedMoveRow } from "./move-row.ts";

const facts = {
  ...emptyFacts("g5", "g6", "c6"),
  fromGroupName: "2-GURUH VIP 5.0", fromCourseId: "c5", fromCourseTitle: "AI CREATORS 5.0",
  toCourseTitle: "AI CREATORS CHALLENGE 6.0", oldCourseWaiting: 2,
};

Deno.test("a refused move has NO userId, so staff-intake/sheet-sync never set the new course's tier", () => {
  const row = refusedMoveRow(facts, "cross_course", { email: "tg-ali@telegram.local", row_index: 1, identifier_used: "@ali" }, "u1");
  assertEquals("userId" in row, false);
  assertEquals(row.matched_user_id, "u1");
  assertEquals(row.status, "cross_course_refused");
  assertEquals(row.reason, "cross_course");
  assertEquals(row.move, {
    current_group: "2-GURUH VIP 5.0", current_course: "AI CREATORS 5.0",
    target_course: "AI CREATORS CHALLENGE 6.0", old_course_waiting: 2,
  });
  assertStringIncludes(row.error, "faqat yangi o'quvchilar uchun");
});

Deno.test("the bot's auto-register reads a refusal as engine_refused (no userId -> no profile link attempt)", () => {
  // registerProvisionalViaEngine: `if (!r0.userId) { recordAutoRegisterFailed(..., "engine_refused", ...) }`.
  const r0 = refusedMoveRow(facts, "cross_course", { email: "x", row_index: 1, identifier_used: "tg_id:1" }, "u1") as { userId?: string };
  assertEquals(!r0.userId, true);
});

// PR-3b: the refusal the DATABASE guard raises at the write (profiles_course_move_guard, 20260930181000).
// MESSAGE and DETAIL exactly as the trigger builds them (verified in the PGlite harness,
// supabase/functions/_watchdogs/testing/cross-course-guard-check.ts); PostgREST passes them through as
// error.message / error.details.
const dbErr = {
  code: "P0001",
  message: "cross_course_refused: Aziza Karimova boshqa kursga (AI CREATORS CHALLENGE 6.0) o'tkazilmadi: eski kursda " +
    "(AI CREATORS 5.0) 1 ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak. Hech kim ko'chirilmadi.",
  details: JSON.stringify({
    user_id: "u1", student: "Aziza Karimova", cross: true, old_course_waiting: 1,
    from_group_id: "g5", from_group: "2-GURUH VIP 5.0", from_course_id: "c5", from_course: "AI CREATORS 5.0",
    to_group_id: "g6", to_group: "AC CHALLENGE | 3-GURUH", to_course_id: "c6", to_course: "AI CREATORS CHALLENGE 6.0",
  }),
};
const rowCtx = { email: "tg-ali@telegram.local", row_index: 3, identifier_used: "@ali" };

Deno.test("a database refusal at the write becomes the same refusal row (no userId, reason old_course_waiting)", () => {
  const row = dbRefusedMoveRow(dbErr, rowCtx, "u1");
  assertEquals(row === null, false);
  assertEquals("userId" in row!, false);
  assertEquals(row!.status, "cross_course_refused");
  assertEquals(row!.reason, "old_course_waiting");
  assertEquals(row!.matched_user_id, "u1");
  assertEquals(row!.move, {
    current_group: "2-GURUH VIP 5.0", current_course: "AI CREATORS 5.0",
    target_course: "AI CREATORS CHALLENGE 6.0", old_course_waiting: 1,
  });
  assertStringIncludes(row!.error, "1 ta vazifa hali baholanmagan");
});

Deno.test("any other write error is not a refusal: null, the caller keeps its generic error row", () => {
  assertEquals(dbRefusedMoveRow({ message: "duplicate key value violates unique constraint" }, rowCtx, "u1"), null);
  assertEquals(dbRefusedMoveRow({ message: "Bu maydonni faqat admin o‘zgartira oladi" }, rowCtx, "u1"), null);
  assertEquals(dbRefusedMoveRow({ message: "later: cross_course_refused: not a prefix" }, rowCtx, "u1"), null);
  assertEquals(dbRefusedMoveRow(null, rowCtx, "u1"), null);
});

Deno.test("unreadable DETAIL: still a refusal, and it keeps the database's own sentence (never '0 waiting')", () => {
  const row = dbRefusedMoveRow({ message: dbErr.message, details: "not json" }, rowCtx, "u1");
  assertEquals(row!.status, "cross_course_refused");
  assertEquals(row!.move.old_course_waiting, null);
  assertEquals(row!.error.startsWith("Aziza Karimova boshqa kursga"), true);
  assertEquals(dbRefusalFacts({ message: dbErr.message, details: "[1,2]" })!.fromCourseTitle, null);
});
