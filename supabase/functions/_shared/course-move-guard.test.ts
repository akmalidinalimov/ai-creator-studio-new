// Tests for the cross-course move guard. Run: deno test supabase/functions/_shared/course-move-guard.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminIdFromBearer,
  type CourseMoveFacts,
  countWaitingInCourse,
  decideCourseMove,
  emptyFacts,
  isAdminUser,
  isCrossCourse,
  loadCourseMoveFacts,
  moveAuditDetails,
  overridePossible,
  refusalMessage,
} from "./course-move-guard.ts";

// Live ids/titles (prod, 2026-09-30): the two courses a teacher can now teach side by side.
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8"; // AI CREATORS 5.0
const C6 = "f502f631-2104-4834-b6c2-702cd3080e27"; // AI CREATORS CHALLENGE 6.0
const G5 = "g-2-vip-5"; // 2-GURUH VIP 5.0
const G5B = "g-1-vip-5"; // 1-GURUH VIP 5.0
const G6 = "g-ac-3"; // AC CHALLENGE | 3-GURUH

function facts(p: Partial<CourseMoveFacts>): CourseMoveFacts {
  return { ...emptyFacts(G5, G6, C6), fromCourseId: C5, fromGroupName: "2-GURUH VIP 5.0", ...p };
}
const NO = { requested: false, adminId: null };

// ---- decision ----

Deno.test("decide: a new student / groupless student is not a move", () => {
  assertEquals(decideCourseMove(emptyFacts(null, G6, C6), NO), { kind: "no_move" });
});

Deno.test("decide: re-submitting into the same group is not a move", () => {
  assertEquals(decideCourseMove(facts({ toGroupId: G5, toCourseId: C5 }), NO), { kind: "no_move" });
});

Deno.test("decide: a move inside one course keeps the old confirm flow", () => {
  const f = facts({ toGroupId: G5B, toCourseId: C5, oldCourseWaiting: 6 });
  assertEquals(isCrossCourse(f), false);
  assertEquals(decideCourseMove(f, NO), { kind: "same_course" });
});

Deno.test("decide: 5.0 -> 6.0 is refused by default, even with nothing waiting", () => {
  assertEquals(decideCourseMove(facts({ oldCourseWaiting: 0 }), NO), { kind: "refused", reason: "cross_course" });
  assertEquals(decideCourseMove(facts({ oldCourseWaiting: 2 }), NO), { kind: "refused", reason: "cross_course" });
});

Deno.test("decide: 6.0 -> 5.0 is refused too (the rule is symmetric)", () => {
  const f = facts({ fromGroupId: G6, fromCourseId: C6, toGroupId: G5, toCourseId: C5, oldCourseWaiting: 0 });
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "cross_course" });
});

Deno.test("decide: a new target group (no id yet) is judged by the target COURSE", () => {
  const f = facts({ toGroupId: null, toCourseId: C6, oldCourseWaiting: 0 });
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "cross_course" });
});

Deno.test("decide: override asked without a verified admin is refused", () => {
  assertEquals(
    decideCourseMove(facts({ oldCourseWaiting: 0 }), { requested: true, adminId: null }),
    { kind: "refused", reason: "override_not_admin" },
  );
});

Deno.test("decide: an admin override is refused while old-course homework waits", () => {
  assertEquals(
    decideCourseMove(facts({ oldCourseWaiting: 1 }), { requested: true, adminId: "admin-1" }),
    { kind: "refused", reason: "old_course_waiting" },
  );
});

Deno.test("decide: an admin override with 0 waiting is allowed and names the admin", () => {
  assertEquals(
    decideCourseMove(facts({ oldCourseWaiting: 0 }), { requested: true, adminId: "admin-1" }),
    { kind: "override", adminId: "admin-1" },
  );
});

Deno.test("decide: an override can never pass on an uncounted waiting total", () => {
  assertEquals(
    decideCourseMove(facts({ oldCourseWaiting: null }), { requested: true, adminId: "admin-1" }),
    { kind: "refused", reason: "check_failed" },
  );
});

Deno.test("decide: a failed lookup refuses (never move blind), even a would-be same-course move", () => {
  const f = { ...emptyFacts(G5, G5B, C5), lookupFailed: true };
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "check_failed" });
});

Deno.test("decide: a group whose course is unknown (read fine) is treated as same-course, as before", () => {
  assertEquals(decideCourseMove(facts({ fromCourseId: null }), NO), { kind: "same_course" });
  assertEquals(decideCourseMove(facts({ toCourseId: null }), NO), { kind: "same_course" });
});

Deno.test("overridePossible: only cross-course with exactly 0 waiting", () => {
  assertEquals(overridePossible(facts({ oldCourseWaiting: 0 })), true);
  assertEquals(overridePossible(facts({ oldCourseWaiting: 3 })), false);
  assertEquals(overridePossible(facts({ oldCourseWaiting: null })), false);
  assertEquals(overridePossible(facts({ toGroupId: G5B, toCourseId: C5, oldCourseWaiting: 0 })), false);
});

// ---- counting ----

Deno.test("countWaitingInCourse: counts only the named course, tolerates array embeds and nulls", () => {
  const rows = [
    { homework_assignments: { modules: { course_id: C5 } } },
    { homework_assignments: [{ modules: [{ course_id: C5 }] }] },
    { homework_assignments: { modules: { course_id: C6 } } },
    { homework_assignments: null },
    { homework_assignments: { modules: null } },
  ];
  assertEquals(countWaitingInCourse(rows, C5), 2);
  assertEquals(countWaitingInCourse(rows, C6), 1);
  assertEquals(countWaitingInCourse([], C5), 0);
});

// ---- the loader, over a fake that honours the exact filter chain ----

type Tables = {
  groups?: Array<{ id: string; name: string; course_id: string | null }>;
  courses?: Array<{ id: string; title: string }>;
  homework_submissions?: Array<{ user_id: string; score: number | null; score_is_stale: boolean; course_id: string }>;
  user_roles?: Array<{ user_id: string; role: string }>;
};

function fakeDb(t: Tables, opts: { failOn?: string; throwOn?: string; users?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const db = {
    calls,
    auth: {
      getUser: (token: string) => {
        const id = opts.users?.[token];
        return Promise.resolve(id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } });
      },
    },
    from: (table: string) => {
      calls.push(table);
      if (opts.throwOn === table) throw new Error("network down");
      const f: { inCol?: string; inVals?: string[]; eqs: Array<[string, unknown]>; waitingOnly?: boolean } = { eqs: [] };
      const run = () => {
        if (opts.failOn === table) return { data: null, error: { message: "boom" } };
        // deno-lint-ignore no-explicit-any
        let rows: any[] = ((t as any)[table] || []).slice();
        if (f.inCol) rows = rows.filter((r) => f.inVals!.includes(r[f.inCol!]));
        for (const [c, v] of f.eqs) rows = rows.filter((r) => r[c] === v);
        if (f.waitingOnly) rows = rows.filter((r) => r.score === null || r.score_is_stale === true);
        if (table === "homework_submissions") {
          rows = rows.map((r) => ({ id: "s", homework_assignments: { modules: { course_id: r.course_id } } }));
        }
        return { data: rows, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const qb: any = {
        select: (_c: string) => qb,
        in: (col: string, vals: string[]) => { f.inCol = col; f.inVals = vals; return qb; },
        eq: (col: string, v: unknown) => { f.eqs.push([col, v]); return qb; },
        or: (expr: string) => { if (expr === "score.is.null,score_is_stale.is.true") f.waitingOnly = true; return qb; },
        limit: (_n: number) => Promise.resolve(run()),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return qb;
    },
  };
  return db;
}

const LIVE: Tables = {
  groups: [
    { id: G5, name: "2-GURUH VIP 5.0", course_id: C5 },
    { id: G5B, name: "1-GURUH VIP 5.0", course_id: C5 },
    { id: G6, name: "AC CHALLENGE | 3-GURUH", course_id: C6 },
  ],
  courses: [{ id: C5, title: "AI CREATORS 5.0" }, { id: C6, title: "AI CREATORS CHALLENGE 6.0" }],
  homework_submissions: [
    { user_id: "u1", score: null, score_is_stale: false, course_id: C5 }, // waiting
    { user_id: "u1", score: 8, score_is_stale: true, course_id: C5 },     // stale = waiting
    { user_id: "u1", score: 9, score_is_stale: false, course_id: C5 },    // graded
    { user_id: "u2", score: null, score_is_stale: false, course_id: C5 }, // someone else's
  ],
};

Deno.test("load: a 5.0 student with 2 waiting (1 ungraded + 1 stale) moving to a 6.0 group", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE), { userId: "u1", fromGroupId: G5, toGroupId: G6, toCourseId: null });
  assertEquals(f.fromGroupName, "2-GURUH VIP 5.0");
  assertEquals(f.fromCourseTitle, "AI CREATORS 5.0");
  assertEquals(f.toCourseId, C6);
  assertEquals(f.toCourseTitle, "AI CREATORS CHALLENGE 6.0");
  assertEquals(f.oldCourseWaiting, 2);
  assertEquals(f.lookupFailed, false);
  assertEquals(decideCourseMove(f, { requested: true, adminId: "a" }), { kind: "refused", reason: "old_course_waiting" });
});

Deno.test("load: the target group's own course beats the caller's course hint", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE), { userId: "u9", fromGroupId: G5, toGroupId: G6, toCourseId: C5 });
  assertEquals(f.toCourseId, C6);
  assertEquals(isCrossCourse(f), true);
  assertEquals(f.oldCourseWaiting, 0);
});

Deno.test("load: a not-yet-created target group uses the hint course", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE), { userId: "u9", fromGroupId: G5, toGroupId: null, toCourseId: C6 });
  assertEquals(f.toCourseId, C6);
  assertEquals(f.toCourseTitle, "AI CREATORS CHALLENGE 6.0");
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "cross_course" });
});

Deno.test("load: no current group -> no queries at all", async () => {
  const db = fakeDb(LIVE);
  const f = await loadCourseMoveFacts(db, { userId: "u1", fromGroupId: null, toGroupId: G6, toCourseId: C6 });
  assertEquals(db.calls, []);
  assertEquals(decideCourseMove(f, NO), { kind: "no_move" });
});

Deno.test("load: a groups read error marks the facts as failed -> refused", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE, { failOn: "groups" }), { userId: "u1", fromGroupId: G5, toGroupId: G5B, toCourseId: C5 });
  assertEquals(f.lookupFailed, true);
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "check_failed" });
});

Deno.test("load: a thrown read never escapes; it is a failed lookup", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE, { throwOn: "groups" }), { userId: "u1", fromGroupId: G5, toGroupId: G6, toCourseId: C6 });
  assertEquals(f.lookupFailed, true);
});

Deno.test("load: a failed waiting count is null — informational for a same-course move, blocks an override", async () => {
  const same = await loadCourseMoveFacts(fakeDb(LIVE, { failOn: "homework_submissions" }), { userId: "u1", fromGroupId: G5, toGroupId: G5B, toCourseId: C5 });
  assertEquals(same.oldCourseWaiting, null);
  assertEquals(decideCourseMove(same, NO), { kind: "same_course" });
  const cross = await loadCourseMoveFacts(fakeDb(LIVE, { failOn: "homework_submissions" }), { userId: "u1", fromGroupId: G5, toGroupId: G6, toCourseId: C6 });
  assertEquals(decideCourseMove(cross, { requested: true, adminId: "a" }), { kind: "refused", reason: "check_failed" });
});

Deno.test("load: a failed course-title read still decides (titles only feed messages)", async () => {
  const f = await loadCourseMoveFacts(fakeDb(LIVE, { failOn: "courses" }), { userId: "u1", fromGroupId: G5, toGroupId: G6, toCourseId: C6 });
  assertEquals(f.lookupFailed, false);
  assertEquals(f.fromCourseTitle, null);
  assertEquals(decideCourseMove(f, NO), { kind: "refused", reason: "cross_course" });
  assertStringIncludes(refusalMessage(f, "cross_course"), "boshqa kursga o'tkazib bo'lmaydi");
});

// ---- admin identity ----

Deno.test("isAdminUser: admin and superadmin yes; teacher, unknown and read errors no", async () => {
  const t: Tables = { user_roles: [{ user_id: "a", role: "admin" }, { user_id: "s", role: "superadmin" }, { user_id: "t", role: "teacher" }] };
  assertEquals(await isAdminUser(fakeDb(t), "a"), true);
  assertEquals(await isAdminUser(fakeDb(t), "s"), true);
  assertEquals(await isAdminUser(fakeDb(t), "t"), false);
  assertEquals(await isAdminUser(fakeDb(t), null), false);
  assertEquals(await isAdminUser(fakeDb(t, { failOn: "user_roles" }), "a"), false);
});

Deno.test("adminIdFromBearer: only a real admin session counts; the publishable key is nobody", async () => {
  const t: Tables = { user_roles: [{ user_id: "a", role: "admin" }, { user_id: "t", role: "teacher" }] };
  const db = fakeDb(t, { users: { "jwt-admin": "a", "jwt-teacher": "t" } });
  assertEquals(await adminIdFromBearer(db, "Bearer jwt-admin"), "a");
  assertEquals(await adminIdFromBearer(db, "Bearer jwt-teacher"), null);
  assertEquals(await adminIdFromBearer(db, "Bearer sb_publishable_xxx"), null);
  assertEquals(await adminIdFromBearer(db, ""), null);
  assertEquals(await adminIdFromBearer(db, null), null);
});

// ---- messages / audit ----

Deno.test("messages: the default refusal names the group, both courses and the waiting count", () => {
  const f = facts({ fromCourseTitle: "AI CREATORS 5.0", toCourseTitle: "AI CREATORS CHALLENGE 6.0", oldCourseWaiting: 2 });
  const m = refusalMessage(f, "cross_course");
  assertStringIncludes(m, "2-GURUH VIP 5.0");
  assertStringIncludes(m, "AI CREATORS 5.0");
  assertStringIncludes(m, "AI CREATORS CHALLENGE 6.0 faqat yangi o'quvchilar uchun");
  assertStringIncludes(m, "2 ta vazifa hali baholanmagan");
  assertStringIncludes(refusalMessage({ ...f, oldCourseWaiting: 0 }, "cross_course"), "baholanmagan vazifa yo'q");
  assertStringIncludes(refusalMessage(f, "old_course_waiting"), "2 ta vazifa");
  assert(refusalMessage(f, "override_not_admin").includes("admin"));
  assert(refusalMessage(f, "check_failed").includes("Qayta urinib"));
});

Deno.test("audit details carry both sides of the move and the waiting count", () => {
  const d = moveAuditDetails(facts({ oldCourseWaiting: 0, toCourseTitle: "AI CREATORS CHALLENGE 6.0" }), { reason: "cross_course" });
  assertEquals(d.from_group_id, G5);
  assertEquals(d.to_group_id, G6);
  assertEquals(d.from_course_id, C5);
  assertEquals(d.to_course_id, C6);
  assertEquals(d.old_course_waiting, 0);
  assertEquals(d.reason, "cross_course");
});
