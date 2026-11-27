import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTaskGroupId } from "./task-group.ts";

// A fake service-role client: modules / profiles reads + the student_group_for_course RPC.
function fakeAdmin(opts: {
  moduleCourse?: string | null;
  moduleErr?: string;
  rule?: string | null;          // what student_group_for_course returns
  ruleErr?: string;
  mainGroup?: string | null;
  profileErr?: string;
}) {
  const calls: { rpc: unknown[]; tables: string[] } = { rpc: [], tables: [] };
  const admin = {
    from(table: string) {
      calls.tables.push(table);
      const res = table === "modules"
        ? (opts.moduleErr ? { data: null, error: { message: opts.moduleErr } }
                          : { data: opts.moduleCourse === undefined ? null : { course_id: opts.moduleCourse }, error: null })
        : (opts.profileErr ? { data: null, error: { message: opts.profileErr } }
                           : { data: { group_id: opts.mainGroup ?? null }, error: null });
      const q = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve(res) };
      return q;
    },
    rpc(fn: string, args: unknown) {
      calls.rpc.push([fn, args]);
      return Promise.resolve(opts.ruleErr ? { data: null, error: { message: opts.ruleErr } } : { data: opts.rule ?? null, error: null });
    },
  };
  return { admin, calls };
}

Deno.test("single-course student: the rule answers their main group (unchanged behaviour)", async () => {
  const { admin, calls } = fakeAdmin({ moduleCourse: "c1", rule: "main-g", mainGroup: "main-g" });
  assertEquals(await resolveTaskGroupId(admin, "u1", "m1"), { groupId: "main-g", fallbackReason: null });
  assertEquals(calls.rpc, [["student_group_for_course", { _uid: "u1", _course: "c1" }]]);
});

Deno.test("second-course task: the group of THAT course, not the main group", async () => {
  const { admin, calls } = fakeAdmin({ moduleCourse: "c2", rule: "second-g", mainGroup: "main-g" });
  assertEquals(await resolveTaskGroupId(admin, "u1", "m2"), { groupId: "second-g", fallbackReason: null });
  assertEquals(calls.tables.includes("profiles"), false);
});

Deno.test("the rule fails → main group, and the fallback is reported", async () => {
  const { admin } = fakeAdmin({ moduleCourse: "c2", ruleErr: "boom", mainGroup: "main-g" });
  const r = await resolveTaskGroupId(admin, "u1", "m2");
  assertEquals(r.groupId, "main-g");
  assertEquals(r.fallbackReason, "group_rule_failed: boom");
});

Deno.test("the module read fails → main group, reported; no RPC", async () => {
  const { admin, calls } = fakeAdmin({ moduleErr: "down", mainGroup: "main-g" });
  const r = await resolveTaskGroupId(admin, "u1", "m2");
  assertEquals(r, { groupId: "main-g", fallbackReason: "module_lookup_failed: down" });
  assertEquals(calls.rpc.length, 0);
});

Deno.test("no module / a course-less module → main group, not a fallback", async () => {
  assertEquals(await resolveTaskGroupId(fakeAdmin({ mainGroup: "main-g" }).admin, "u1", null),
    { groupId: "main-g", fallbackReason: null });
  assertEquals(await resolveTaskGroupId(fakeAdmin({ moduleCourse: null, mainGroup: "main-g" }).admin, "u1", "m1"),
    { groupId: "main-g", fallbackReason: null });
});

Deno.test("no group anywhere → null (the caller answers no_group as before)", async () => {
  assertEquals(await resolveTaskGroupId(fakeAdmin({ moduleCourse: "c1", rule: null, mainGroup: null }).admin, "u1", "m1"),
    { groupId: null, fallbackReason: null });
});

Deno.test("a failed profile read still throws (never misread as 'no group')", async () => {
  await assertRejects(() => resolveTaskGroupId(fakeAdmin({ moduleErr: "down", profileErr: "x" }).admin, "u1", "m1"));
});
