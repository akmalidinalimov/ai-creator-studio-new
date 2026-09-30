// Tests for the allows_write_to_pm stamp (Daily Tasks PR-7). Run: deno test supabase/functions/tg-miniapp-auth/write-access.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stampWriteAccess } from "./write-access.ts";

function fakeAdmin(answer: { data: unknown; error: unknown } | "throw") {
  const writes: { table: string; row: any; where: string[] }[] = [];
  const health: any[] = [];
  const admin = {
    from: (table: string) => {
      if (table === "admin_actions") return { insert: (row: any) => { health.push(row); return Promise.resolve({ error: null }); } };
      const w = { table, row: null as any, where: [] as string[] };
      const b: any = {
        update: (row: any) => { w.row = row; return b; },
        eq: (c: string, v: unknown) => { w.where.push(`${c}=${v}`); return b; },
        is: (c: string, v: unknown) => { w.where.push(`${c} is ${v}`); return b; },
        select: () => {
          writes.push(w);
          return answer === "throw" ? Promise.reject(new Error("network")) : Promise.resolve(answer);
        },
      };
      return b;
    },
  };
  return { admin, writes, health };
}

Deno.test("stampWriteAccess: stamps once — only a profile whose telegram_write_access_at is still NULL", async () => {
  const { admin, writes, health } = fakeAdmin({ data: [{ id: "p1" }], error: null });
  const now = new Date("2026-10-05T04:00:00Z");
  assertEquals(await stampWriteAccess(admin, "p1", now), "stamped");
  assertEquals(writes[0].table, "profiles");
  assertEquals(writes[0].row, { telegram_write_access_at: "2026-10-05T04:00:00.000Z" });
  assertEquals(writes[0].where, ["id=p1", "telegram_write_access_at is null"]);
  assertEquals(health.length, 0);
});

Deno.test("stampWriteAccess: already stamped → 'already', no signal", async () => {
  const { admin, health } = fakeAdmin({ data: [], error: null });
  assertEquals(await stampWriteAccess(admin, "p1"), "already");
  assertEquals(health.length, 0);
});

Deno.test("stampWriteAccess: a DB error or a throw is DB-visible, never blocks (resolves 'failed')", async () => {
  const a = fakeAdmin({ data: null, error: { code: "P0001", message: "Bu maydonni faqat admin o‘zgartira oladi" } });
  assertEquals(await stampWriteAccess(a.admin, "p1"), "failed");
  assertEquals(a.health.map((h) => h.action), ["miniapp_write_access_stamp_failed"]);
  assertEquals(a.health[0].details.code, "P0001");
  const b = fakeAdmin("throw");
  assertEquals(await stampWriteAccess(b.admin, "p1"), "failed");
  assertEquals(b.health.length, 1);
});
