// Tests for the shared "teachers of a group" definition. Run: deno test supabase/functions/_shared/group-teachers.test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isReachableTeacher, loadGroupTeachers, mergeGroupTeachers } from "./group-teachers.ts";

Deno.test("merge: primary only (every current group) -> just the primary", () => {
  const m = mergeGroupTeachers([{ id: "g1", teacher_id: "p" }], []);
  assertEquals(m.get("g1"), ["p"]);
});

Deno.test("merge: the primary's own mirrored junction row is not a second teacher", () => {
  const m = mergeGroupTeachers([{ id: "g1", teacher_id: "p" }], [{ group_id: "g1", teacher_id: "p" }]);
  assertEquals(m.get("g1"), ["p"]);
});

Deno.test("merge: primary first, then co-teachers, whatever order the junction rows come in", () => {
  const m = mergeGroupTeachers(
    [{ id: "g1", teacher_id: "p" }],
    [{ group_id: "g1", teacher_id: "c1" }, { group_id: "g1", teacher_id: "p" }, { group_id: "g1", teacher_id: "c2" }],
  );
  assertEquals(m.get("g1"), ["p", "c1", "c2"]);
});

Deno.test("merge: a group whose teachers are all co-teachers is NOT teacherless", () => {
  const m = mergeGroupTeachers([{ id: "g1", teacher_id: null }], [{ group_id: "g1", teacher_id: "c1" }]);
  assertEquals(m.get("g1"), ["c1"]);
});

Deno.test("merge: no primary and no junction rows -> an empty entry, not a missing one", () => {
  const m = mergeGroupTeachers([{ id: "g1", teacher_id: null }], []);
  assertEquals(m.get("g1"), []);
});

Deno.test("merge: groups do not leak teachers into each other", () => {
  const m = mergeGroupTeachers(
    [{ id: "g1", teacher_id: "p1" }, { id: "g2", teacher_id: "p2" }],
    [{ group_id: "g1", teacher_id: "p2" }],
  );
  assertEquals(m.get("g1"), ["p1", "p2"]);
  assertEquals(m.get("g2"), ["p2"]);
});

Deno.test("reachable: the drainer's rule — telegram_id set and notifications not switched off", () => {
  assertEquals(isReachableTeacher({ telegram_id: 123, notifications_enabled: true }), true);
  assertEquals(isReachableTeacher({ telegram_id: "123", notifications_enabled: null }), true);
  assertEquals(isReachableTeacher({ telegram_id: 123 }), true);
  assertEquals(isReachableTeacher({ telegram_id: 123, notifications_enabled: false }), false);
  assertEquals(isReachableTeacher({ telegram_id: null, notifications_enabled: true }), false);
  assertEquals(isReachableTeacher(null), false);
  assertEquals(isReachableTeacher(undefined), false);
});

// Minimal service-role-client stub: .from(table).select(cols).in(col, ids) -> { data, error }.
type Row = Record<string, string | null>;
function fakeAdmin(tables: Record<string, { data?: Row[]; error?: { message: string } }>) {
  const calls: string[] = [];
  const admin = {
    from: (t: string) => ({
      select: (_c: string) => ({
        in: (col: string, ids: string[]) => {
          calls.push(`${t}.${col}:${ids.join(",")}`);
          const spec = tables[t] ?? {};
          if (spec.error) return Promise.resolve({ data: null, error: spec.error });
          return Promise.resolve({ data: (spec.data ?? []).filter((r) => ids.includes(r[col] ?? "")), error: null });
        },
      }),
    }),
  };
  return { admin, calls };
}

Deno.test("load: two reads, merged, every requested group present, null/duplicate ids ignored", async () => {
  const { admin, calls } = fakeAdmin({
    groups: { data: [{ id: "g1", teacher_id: "p1" }, { id: "g2", teacher_id: null }, { id: "g9", teacher_id: "x" }] },
    group_teachers: { data: [{ group_id: "g1", teacher_id: "p1" }, { group_id: "g1", teacher_id: "c1" }, { group_id: "g2", teacher_id: "c2" }] },
  });
  const m = await loadGroupTeachers(admin, ["g1", "g2", "g3", null, undefined, "g1"]);
  assertEquals(m.get("g1"), ["p1", "c1"]);
  assertEquals(m.get("g2"), ["c2"]);
  assertEquals(m.get("g3"), []);
  assertEquals(m.has("g9"), false);
  assertEquals(calls.length, 2);
});

Deno.test("load: no ids -> no reads", async () => {
  const { admin, calls } = fakeAdmin({});
  const m = await loadGroupTeachers(admin, [null, undefined]);
  assertEquals(m.size, 0);
  assertEquals(calls.length, 0);
});

Deno.test("load: a failed read throws instead of reading as 'no teacher'", async () => {
  const a = fakeAdmin({ groups: { error: { message: "boom" } }, group_teachers: { data: [] } }).admin;
  await assertRejects(() => loadGroupTeachers(a, ["g1"]), Error, "groups read failed");
  const b = fakeAdmin({ groups: { data: [{ id: "g1", teacher_id: "p" }] }, group_teachers: { error: { message: "boom" } } }).admin;
  await assertRejects(() => loadGroupTeachers(b, ["g1"]), Error, "group_teachers read failed");
});
