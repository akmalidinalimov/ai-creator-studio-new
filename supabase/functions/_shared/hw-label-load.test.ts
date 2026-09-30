// Tests for the label readers. Run: deno test supabase/functions/_shared/hw-label-load.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ASSIGNMENT_LABEL_SELECT,
  assignmentLabelInfo,
  labelOf,
  loadAssignmentLabels,
  loadGroupNames,
  loadHwLabel,
  tagOf,
} from "./hw-label-load.ts";

// A live-shaped row: the 6.0 clone of a 5.0 SAP sub-step (parent set → the step is sap_number).
const ROW_6 = {
  id: "a6", title: "3-MODUL UYGA VAZIFALARI", max_score: 10, task_number: 3, sap_number: 2, parent_id: "p6", module_id: "m6",
  modules: { position: 2, title: "AI BILAN PRO VIDEOLAR TAYYORLASH", courses: { title: "AI CREATORS CHALLENGE 6.0" } },
};
const ROW_5 = {
  id: "a5", title: "2-MODUL ERKAKLAR KO'Z OYNAGI", max_score: 10, task_number: 1, sap_number: null, parent_id: null, module_id: "m5",
  modules: { position: 1, title: "2-MODUL", courses: { title: "AI CREATORS 5.0" } },
};

type Call = { table: string; select?: string; col?: string; ids?: string[]; insert?: unknown };

/** Just enough of supabase-js for these readers + logHealthOnce. `fail` makes a table's read return an error. */
function fakeDb(rows: Record<string, unknown[]>, fail: Set<string> = new Set()) {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      const call: Call = { table };
      calls.push(call);
      const chain = {
        select(sel: string) { call.select = sel; return chain; },
        eq() { return chain; },
        gte() { return chain; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        in(col: string, ids: string[]) {
          call.col = col; call.ids = ids;
          if (fail.has(table)) return Promise.resolve({ data: null, error: { message: `${table} boom` } });
          const data = (rows[table] || []).filter((r) => ids.includes((r as { id: string }).id));
          return Promise.resolve({ data, error: null });
        },
        insert(v: unknown) { call.insert = v; return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  };
  return db;
}

Deno.test("assignmentLabelInfo: course from the TASK's module, module number = position + 1, SAP step", () => {
  assertEquals(assignmentLabelInfo(ROW_6), {
    id: "a6", title: "3-MODUL UYGA VAZIFALARI", maxScore: 10, moduleNumber: 3,
    moduleTitle: "AI BILAN PRO VIDEOLAR TAYYORLASH", step: 2, courseTitle: "AI CREATORS CHALLENGE 6.0",
  });
});

Deno.test("assignmentLabelInfo: tolerates array embeds, a missing module / course, and a missing row", () => {
  const arr = { ...ROW_5, modules: [{ position: 0, title: "M", courses: [{ title: "AI CREATORS 5.0" }] }] };
  assertEquals(assignmentLabelInfo(arr)?.courseTitle, "AI CREATORS 5.0");
  assertEquals(assignmentLabelInfo(arr)?.moduleNumber, 1);
  const bare = assignmentLabelInfo({ id: "x", title: "T", task_number: 2 });
  assertEquals(bare, { id: "x", title: "T", maxScore: null, moduleNumber: null, moduleTitle: null, step: 2, courseTitle: null });
  assertEquals(assignmentLabelInfo(null), null);
  assertEquals(assignmentLabelInfo({}), null);
});

Deno.test("labelOf / tagOf", () => {
  const i6 = assignmentLabelInfo(ROW_6);
  assertEquals(labelOf(i6, "AC CHALLENGE | 3-GURUH"), "CH6 · 3-GURUH · M3 V2 — 3-MODUL UYGA VAZIFALARI");
  assertEquals(tagOf(i6, "AC CHALLENGE | 3-GURUH"), "CH6 · 3-GURUH · M3 V2");
  assertEquals(labelOf(null, "AC CHALLENGE | 3-GURUH"), "");
  assertEquals(tagOf(null, "AC CHALLENGE | 3-GURUH"), "AC CHALLENGE | 3-GURUH");
});

Deno.test("loadAssignmentLabels / loadGroupNames: one read each, deduped ids, the shared select", async () => {
  const db = fakeDb({ homework_assignments: [ROW_5, ROW_6], groups: [{ id: "g1", name: "2-GURUH VIP 5.0" }, { id: "g2", name: " " }] });
  const a = await loadAssignmentLabels(db, ["a5", "a6", "a5", null, undefined, ""], "test");
  assertEquals(a.error, null);
  assertEquals([...a.map.keys()].sort(), ["a5", "a6"]);
  const g = await loadGroupNames(db, ["g1", "g2", "g1"], "test");
  assertEquals(g.map.get("g1"), "2-GURUH VIP 5.0");
  assertEquals(g.map.has("g2"), false); // a blank name is no name
  assertEquals(db.calls[0].select, ASSIGNMENT_LABEL_SELECT);
  assertEquals(db.calls[0].ids, ["a5", "a6"]);
  assertEquals(db.calls[1].ids, ["g1", "g2"]);
});

Deno.test("loaders: nothing to read → no query at all", async () => {
  const db = fakeDb({});
  assertEquals((await loadAssignmentLabels(db, [null, ""], "test")).map.size, 0);
  assertEquals((await loadGroupNames(db, [], "test")).map.size, 0);
  assertEquals(db.calls.length, 0);
});

Deno.test("loaders: a failed read never throws, returns the error, and records hw_label_lookup_failed", async () => {
  const db = fakeDb({ groups: [{ id: "g1", name: "G" }] }, new Set(["homework_assignments"]));
  const r = await loadAssignmentLabels(db, ["a5"], "unit-test-src");
  assertEquals(r.map.size, 0);
  assertEquals(r.error, "homework_assignments boom");
  const ins = db.calls.find((c) => c.table === "admin_actions" && c.insert);
  assert(ins, "a health row was written");
  const row = ins!.insert as { action: string; details: Record<string, unknown> };
  assertEquals(row.action, "hw_label_lookup_failed");
  assertEquals(row.details.source, "unit-test-src");
  assertEquals(row.details.part, "assignments");
});

Deno.test("loadHwLabel: one task + one group → label and tag; unknown task → empty label", async () => {
  const db = fakeDb({ homework_assignments: [ROW_5], groups: [{ id: "g1", name: "2-GURUH VIP 5.0" }] });
  const one = await loadHwLabel(db, "a5", "g1", "test");
  assertEquals(one.label, "5.0 · 2-GURUH VIP · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI");
  assertEquals(one.tag, "5.0 · 2-GURUH VIP · M2 V1");
  assertEquals(one.groupName, "2-GURUH VIP 5.0");
  const none = await loadHwLabel(db, "nope", null, "test");
  assertEquals(none.label, "");
  assertEquals(none.info, null);
});
