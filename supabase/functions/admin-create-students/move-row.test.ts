// Run: deno test supabase/functions/admin-create-students/move-row.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { emptyFacts } from "../_shared/course-move-guard.ts";
import { refusedMoveRow } from "./move-row.ts";

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
