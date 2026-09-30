// Pins who a student reminder may go to (student-audience.ts). Run: deno test supabase/functions/_shared/student-audience.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isStaffOnly, loadStaffOnlyIds, skipStaffOnly, staffOnlyIdsFromRows } from "./student-audience.ts";

Deno.test("isStaffOnly: a staff role and no student role", () => {
  assert(isStaffOnly(["teacher"]));
  assert(isStaffOnly(["admin"]));
  assert(isStaffOnly(["superadmin"]));
  assert(isStaffOnly(["teacher", "admin"]));
  // The live dual-role accounts (admin+student, teacher+student) are students: they keep their reminders.
  assert(!isStaffOnly(["admin", "student"]));
  assert(!isStaffOnly(["student", "teacher"]));
  assert(!isStaffOnly(["student"]));
  // No role row at all is not staff — the filter must never widen to "anyone without a student row".
  assert(!isStaffOnly([]));
  assert(!isStaffOnly([null, undefined, "unknown_role"]));
});

Deno.test("staffOnlyIdsFromRows: groups every role of a user before deciding", () => {
  const ids = staffOnlyIdsFromRows([
    { user_id: "t1", role: "teacher" },
    { user_id: "t2", role: "teacher" },
    { user_id: "t2", role: "student" },
    { user_id: "a1", role: "admin" },
    { user_id: "s1", role: "student" },
    { user_id: "", role: "teacher" },
  ]);
  assertEquals([...ids].sort(), ["a1", "t1"]);
});

/** A fake client: user_roles answers by the filters the loader uses; admin_actions records health rows. */
function fakeAdmin(roles: { user_id: string; role: string }[], fail: "staff" | "student" | "throw" | null = null) {
  const health: any[] = [];
  const admin = {
    health,
    from(table: string) {
      if (fail === "throw" && table === "user_roles") throw new Error("boom");
      const f: { in?: [string, string[]][]; eq?: [string, string][] } = { in: [], eq: [] };
      const q: any = {
        select: () => q,
        in: (c: string, v: string[]) => { f.in!.push([c, v]); return q; },
        eq: (c: string, v: string) => { f.eq!.push([c, v]); return q; },
        gte: () => q,
        limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: any) => { health.push({ table, row }); return Promise.resolve({ error: null }); },
        then: (res: any, rej: any) => {
          const isStudentRead = f.eq!.some(([c, v]) => c === "role" && v === "student");
          if ((fail === "staff" && !isStudentRead) || (fail === "student" && isStudentRead)) {
            return Promise.resolve({ data: null, error: { message: "permission denied" } }).then(res, rej);
          }
          let rows = roles;
          for (const [c, v] of f.in!) rows = rows.filter((r: any) => v.includes(r[c]));
          for (const [c, v] of f.eq!) rows = rows.filter((r: any) => r[c] === v);
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return admin;
}

const LIVE_LIKE = [
  { user_id: "teacher-only", role: "teacher" },
  { user_id: "teacher-student", role: "teacher" },
  { user_id: "teacher-student", role: "student" },
  { user_id: "admin-student", role: "admin" },
  { user_id: "admin-student", role: "student" },
  { user_id: "super", role: "superadmin" },
  { user_id: "stu", role: "student" },
];

Deno.test("loadStaffOnlyIds: two reads → only the staff without a student role", async () => {
  const admin = fakeAdmin(LIVE_LIKE);
  const s = await loadStaffOnlyIds(admin, "test");
  assertEquals(s.error, null);
  assertEquals([...(s.ids ?? [])].sort(), ["super", "teacher-only"]);
  assert(skipStaffOnly(s, "teacher-only"));
  assert(!skipStaffOnly(s, "teacher-student"));
  assert(!skipStaffOnly(s, "admin-student"));
  assert(!skipStaffOnly(s, "stu"));
  assert(!skipStaffOnly(s, null));
  assertEquals(admin.health.length, 0);
});

Deno.test("loadStaffOnlyIds: no staff at all → empty set, one read", async () => {
  const s = await loadStaffOnlyIds(fakeAdmin([{ user_id: "stu", role: "student" }]), "test");
  assertEquals(s, { ids: new Set(), error: null });
});

for (const fail of ["staff", "student", "throw"] as const) {
  Deno.test(`loadStaffOnlyIds: a failed read (${fail}) filters NOBODY and is DB-visible`, async () => {
    const admin = fakeAdmin(LIVE_LIKE, fail);
    const s = await loadStaffOnlyIds(admin, `fn-${fail}`);
    assertEquals(s.ids, null);
    assert(s.error);
    // Fail-open: every caller sends as before the filter existed.
    assert(!skipStaffOnly(s, "teacher-only"));
    const row = admin.health.find((h) => h.table === "admin_actions")?.row;
    assertEquals(row?.action, "student_audience_read_failed");
    assertEquals(row?.details?.fn, `fn-${fail}`);
    assertEquals(row?.details?.dedupe_key, `fn-${fail}`);
  });
}
