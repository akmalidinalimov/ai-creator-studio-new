// Pins the teacher Mini App button (teacher-miniapp.ts): the decision table, the ?sub= deep link, the kill-switch
// reader. Run: deno test supabase/functions/_shared/teacher-miniapp.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetTeacherMiniAppFlagCache,
  loadTeacherMiniAppFlag,
  parseTeacherMiniAppFlag,
  teacherAppButton,
  teacherGradePath,
  TEACHER_GRADE_PATH,
  TEACHER_HOME_PATH,
} from "./teacher-miniapp.ts";
import { DEFAULT_MINIAPP_BASE, type WatchFlag } from "./miniapp-button.ts";
import { readTrack, stripTrack } from "./miniapp-links.ts";

const SUB = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const ON: WatchFlag = { on: true, watch: true };
const OFF: WatchFlag = { on: false, watch: false };

Deno.test("teacherGradePath: a UUID opens THAT submission; anything else is the plain queue", () => {
  assertEquals(teacherGradePath(SUB), `/tg/teacher/grade?sub=${SUB}`);
  assertEquals(teacherGradePath(SUB.toUpperCase()), `/tg/teacher/grade?sub=${SUB}`);
  assertEquals(teacherGradePath(null), TEACHER_GRADE_PATH);
  assertEquals(teacherGradePath("1; drop table"), TEACHER_GRADE_PATH);
  assertEquals(teacherGradePath("../../admin"), TEACHER_GRADE_PATH);
});

Deno.test("private chat + flag on → web_app to the exact screen, tracked; the tracking strips back to ?sub=", async () => {
  const b = await teacherAppButton({
    text: "🎯 Baholash", flag: ON, chatId: 111, path: teacherGradePath(SUB), src: "teacher_hw_dm", ref: SUB, fn: "t",
  });
  const url = `${DEFAULT_MINIAPP_BASE}/tg/teacher/grade?sub=${SUB}&src=teacher_hw_dm&ref=${SUB}`;
  assertEquals(b, { text: "🎯 Baholash", web_app: { url } });
  // What the Mini App does with it: the open signal is read, then src/ref are stripped and ?sub= stays.
  const search = new URL(url).search;
  assertEquals(readTrack(search), { src: "teacher_hw_dm", ref: SUB });
  assertEquals(stripTrack(search), `?sub=${SUB}`);
});

Deno.test("flag off → null (the sender keeps today's button, byte-identical)", async () => {
  assertEquals(await teacherAppButton({ text: "x", flag: OFF, chatId: 111, path: TEACHER_HOME_PATH, src: "teacher_report", fn: "t" }), null);
});

Deno.test("never a web_app button outside a private chat or outside /tg/teacher", async () => {
  for (const chatId of [-1001234567890, 0, null, undefined, "abc"]) {
    assertEquals(await teacherAppButton({ text: "x", flag: ON, chatId, path: TEACHER_HOME_PATH, src: "teacher_card", fn: "t" }), null);
  }
  assertEquals(await teacherAppButton({ text: "x", flag: ON, chatId: 1, path: "/dashboard", src: "teacher_card", fn: "t" }), null);
});

Deno.test("a malformed MINIAPP_BASE → null + the bad_base alarm row", async () => {
  const inserts: any[] = [];
  const admin = {
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: any) => { inserts.push(row); return Promise.resolve({ error: null }); },
      };
      return q;
    },
  };
  const b = await teacherAppButton({
    text: "x", flag: ON, chatId: 5, path: TEACHER_HOME_PATH, src: "teacher_report", fn: "teacher-daily-digest",
    admin, base: "http://insecure.example",
  });
  assertEquals(b, null);
  assertEquals(inserts[0]?.action, "miniapp_button_fallback");
});

Deno.test("parseTeacherMiniAppFlag: absent → on (like the webhook); present → only a literal true", () => {
  assertEquals(parseTeacherMiniAppFlag(null), ON);
  assertEquals(parseTeacherMiniAppFlag({ value: { enabled: true } }), ON);
  assertEquals(parseTeacherMiniAppFlag({ value: { enabled: false } }), OFF);
  assertEquals(parseTeacherMiniAppFlag({ value: { enabled: "true" } }), OFF);
  assertEquals(parseTeacherMiniAppFlag({ value: null }), OFF);
});

function flagAdmin(result: { data: unknown; error: unknown } | "throw") {
  const health: any[] = [];
  let reads = 0;
  const admin = {
    health,
    get reads() { return reads; },
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: any) => { health.push(row); return Promise.resolve({ error: null }); },
        maybeSingle: () => {
          reads++;
          if (result === "throw") throw new Error("network");
          return Promise.resolve(result);
        },
      };
      if (table !== "platform_settings" && table !== "admin_actions") throw new Error(table);
      return q;
    },
  };
  return admin;
}

Deno.test("loadTeacherMiniAppFlag: reads once per 60 s", async () => {
  _resetTeacherMiniAppFlagCache();
  const a = flagAdmin({ data: { value: { enabled: true } }, error: null });
  assertEquals(await loadTeacherMiniAppFlag(a, "t", 1_000), ON);
  assertEquals(await loadTeacherMiniAppFlag(a, "t", 30_000), ON);
  assertEquals(a.reads, 1);
  assertEquals(await loadTeacherMiniAppFlag(a, "t", 70_000), ON);
  assertEquals(a.reads, 2);
  _resetTeacherMiniAppFlagCache();
});

for (const r of [{ data: null, error: { message: "permission denied" } }, "throw" as const]) {
  Deno.test(`loadTeacherMiniAppFlag: a read error (${r === "throw" ? "throw" : "error"}) → OFF, not cached, DB-visible`, async () => {
    _resetTeacherMiniAppFlagCache();
    const a = flagAdmin(r);
    assertEquals(await loadTeacherMiniAppFlag(a, `fn-${r === "throw" ? "t" : "e"}`, 1_000), OFF);
    assertEquals(a.health[0]?.action, "teacher_miniapp_flag_read_failed");
    await loadTeacherMiniAppFlag(a, "again", 2_000);
    assert(a.reads >= 2, "a failed read is retried, not cached");
    _resetTeacherMiniAppFlagCache();
  });
}
