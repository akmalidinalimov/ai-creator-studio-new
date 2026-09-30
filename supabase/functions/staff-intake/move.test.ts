// Tests for the /intake form's answer to "this student is already in another group".
// Run: deno test supabase/functions/staff-intake/move.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CourseMoveFacts, decideCourseMove, emptyFacts } from "../_shared/course-move-guard.ts";
import { intakeMoveOutcome } from "./move.ts";

const C5 = "c5", C6 = "c6";
const base = (p: Partial<CourseMoveFacts> = {}): CourseMoveFacts => ({
  ...emptyFacts("g5", "g6", C6),
  fromGroupName: "2-GURUH VIP 5.0", fromCourseId: C5, fromCourseTitle: "AI CREATORS 5.0",
  toCourseTitle: "AI CREATORS CHALLENGE 6.0", oldCourseWaiting: 0, ...p,
});
const run = (f: CourseMoveFacts, o: { override?: boolean; admin?: string | null; confirm?: boolean }) =>
  intakeMoveOutcome(
    f,
    decideCourseMove(f, { requested: !!o.override, adminId: o.admin ?? null }),
    { confirmMove: !!o.confirm, callerAdminId: o.admin ?? null, userId: "u1" },
  );

Deno.test("salesperson, 5.0 -> 6.0: refused with the courses and waiting count; no override offered", () => {
  const out = run(base({ oldCourseWaiting: 2 }), {});
  assertEquals(out.action, "respond");
  if (out.action !== "respond") return;
  assertEquals(out.refused, "cross_course");
  assertEquals(out.body.status, "cross_course_refused");
  assertEquals(out.body.current_group, "2-GURUH VIP 5.0");
  assertEquals(out.body.current_course, "AI CREATORS 5.0");
  assertEquals(out.body.target_course, "AI CREATORS CHALLENGE 6.0");
  assertEquals(out.body.old_course_waiting, 2);
  assertEquals(out.body.can_override, false);
  assertEquals("userId" in out.body, false);
});

Deno.test("confirm_move no longer skips the guard: a crafted confirm across courses is still refused", () => {
  const out = run(base(), { confirm: true });
  assertEquals(out.action, "respond");
  if (out.action === "respond") assertEquals(out.body.status, "cross_course_refused");
});

Deno.test("signed-in admin, 0 waiting: refused by default but the override is offered", () => {
  const out = run(base({ oldCourseWaiting: 0 }), { admin: "admin-1" });
  assertEquals(out.action, "respond");
  if (out.action === "respond") {
    assertEquals(out.body.reason, "cross_course");
    assertEquals(out.body.can_override, true);
  }
});

Deno.test("signed-in admin, homework waiting: no override offered, and an override attempt is refused", () => {
  const first = run(base({ oldCourseWaiting: 1 }), { admin: "admin-1" });
  if (first.action === "respond") assertEquals(first.body.can_override, false);
  const forced = run(base({ oldCourseWaiting: 1 }), { admin: "admin-1", override: true, confirm: true });
  assertEquals(forced.action, "respond");
  if (forced.action === "respond") assertEquals(forced.refused, "old_course_waiting");
});

Deno.test("override asked without an admin session is refused (the access code is not an admin)", () => {
  const out = run(base(), { override: true, confirm: true });
  assertEquals(out.action, "respond");
  if (out.action === "respond") assertEquals(out.refused, "override_not_admin");
});

Deno.test("admin override with 0 waiting proceeds and carries the admin id to the engine", () => {
  assertEquals(run(base(), { admin: "admin-1", override: true, confirm: true }), { action: "proceed", overrideAdminId: "admin-1" });
});

Deno.test("same course, first submit: the old confirm prompt, now with the waiting count", () => {
  const out = run(base({ toGroupId: "g5b", toCourseId: C5, toCourseTitle: "AI CREATORS 5.0", oldCourseWaiting: 3 }), {});
  assertEquals(out.action, "respond");
  if (out.action === "respond") {
    assertEquals(out.refused, null);
    assertEquals(out.body.status, "exists_in_other_group");
    assertEquals(out.body.userId, "u1");
    assertEquals(out.body.old_course_waiting, 3);
  }
});

Deno.test("same course, confirmed: proceeds with no override", () => {
  const f = base({ toGroupId: "g5b", toCourseId: C5 });
  assertEquals(run(f, { confirm: true }), { action: "proceed", overrideAdminId: null });
});

Deno.test("a failed lookup is refused with a retry message, never moved", () => {
  const out = run({ ...base(), lookupFailed: true }, { confirm: true });
  assertEquals(out.action, "respond");
  if (out.action === "respond") assertEquals(out.refused, "check_failed");
});
