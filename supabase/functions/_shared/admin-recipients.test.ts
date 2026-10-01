// Tests for the shared admin-recipient lookup. Run: deno test supabase/functions/_shared/admin-recipients.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adminTelegramIds, toChatIds } from "./admin-recipients.ts";

type Result = { data?: unknown; error?: { message: string } | null };

// A chainable, awaitable stand-in for the supabase-js query builder: every filter call is recorded, and awaiting
// the chain resolves to the table's canned result. A select string with an embed is answered the way PostgREST
// answers it in prod (400 PGRST200), so a regression to the embed form fails here too.
function fakeAdmin(tables: Record<string, Result>, opts: { throwOn?: string } = {}) {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      if (opts.throwOn === table) throw new Error("connection reset");
      let result: Result = tables[table] ?? { data: [], error: null };
      const chain = {
        select(cols: string) {
          calls.push(`${table}.select(${cols})`);
          if (/user_roles\s*[!(]/.test(cols)) {
            result = { data: null, error: { message: "Could not find a relationship between 'profiles' and 'user_roles' in the schema cache" } };
          }
          return chain;
        },
        in(col: string, vals: unknown[]) {
          calls.push(`${table}.in(${col},${vals.join("|")})`);
          return chain;
        },
        not(col: string, op: string, val: unknown) {
          calls.push(`${table}.not(${col},${op},${val})`);
          return chain;
        },
        then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { admin, calls };
}

Deno.test("two queries: admin/superadmin user ids, then their profiles with a telegram_id — no embed", async () => {
  const f = fakeAdmin({
    user_roles: { data: [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u1" }] },
    profiles: { data: [{ id: "u1", telegram_id: 111 }, { id: "u2", telegram_id: "222" }] },
  });
  const r = await adminTelegramIds(f.admin);
  assertEquals(r, { ids: [111, 222], error: null });
  assertEquals(f.calls, [
    "user_roles.select(user_id)",
    "user_roles.in(role,admin|superadmin)",
    "profiles.select(id, telegram_id)",
    "profiles.in(id,u1|u2)",
    "profiles.not(telegram_id,is,null)",
  ]);
});

Deno.test("limit caps the recipients (frontend-deploy-watchdog uses 3, like challenge_tasks_admin_dm)", async () => {
  const f = fakeAdmin({
    user_roles: { data: [{ user_id: "a" }, { user_id: "b" }, { user_id: "c" }, { user_id: "d" }] },
    profiles: { data: [{ telegram_id: 1 }, { telegram_id: 2 }, { telegram_id: 3 }, { telegram_id: 4 }] },
  });
  assertEquals((await adminTelegramIds(f.admin, { limit: 3 })).ids, [1, 2, 3]);
  assertEquals((await adminTelegramIds(f.admin)).ids, [1, 2, 3, 4]);
});

Deno.test("no admins at all: empty, NOT an error, and profiles is not queried", async () => {
  const f = fakeAdmin({ user_roles: { data: [] } });
  assertEquals(await adminTelegramIds(f.admin), { ids: [], error: null });
  assertEquals(f.calls.some((c) => c.startsWith("profiles")), false);
});

Deno.test("a failed read is an error the caller can record, never a silent 'no admins'", async () => {
  const r1 = await adminTelegramIds(fakeAdmin({ user_roles: { error: { message: "permission denied" } } }).admin);
  assertEquals(r1.ids, []);
  assertStringIncludes(r1.error ?? "", "user_roles: permission denied");

  const r2 = await adminTelegramIds(
    fakeAdmin({ user_roles: { data: [{ user_id: "u1" }] }, profiles: { error: { message: "timeout" } } }).admin,
  );
  assertEquals(r2.ids, []);
  assertStringIncludes(r2.error ?? "", "profiles: timeout");

  const r3 = await adminTelegramIds(fakeAdmin({}, { throwOn: "user_roles" }).admin);
  assertEquals(r3.ids, []);
  assertStringIncludes(r3.error ?? "", "connection reset");
});

Deno.test("the embed form the three functions used is what the fake (and prod) reject", async () => {
  // Documents the failure the helper replaces: the old one-query form gets PGRST200 and no rows.
  const f = fakeAdmin({ profiles: { data: [{ telegram_id: 111 }] } });
  const { data, error } = await f.admin.from("profiles").select("telegram_id, user_roles!inner(role)")
    .not("telegram_id", "is", null).in("user_roles.role", ["admin", "superadmin"]);
  assertEquals(data, null);
  assertStringIncludes(error?.message ?? "", "Could not find a relationship");
});

Deno.test("toChatIds: numeric, non-zero, deduplicated, in order; junk skipped", () => {
  assertEquals(toChatIds([{ telegram_id: 5 }, { telegram_id: "5" }, { telegram_id: "7" }]), [5, 7]);
  assertEquals(toChatIds([{ telegram_id: null }, { telegram_id: 0 }, { telegram_id: "" }, { telegram_id: "x" }, null, 3]), []);
  assertEquals(toChatIds([{ telegram_id: -1001234567890 }]), [-1001234567890]);
  assertEquals(toChatIds(null), []);
  assertEquals(toChatIds({ telegram_id: 1 }), []);
});
