// Applies 20260908120000_warmup_schema.sql to a real PostgreSQL and asserts the invariants it is
// supposed to create — the ones that are properties of the SCHEMA, not of any code path.
//
//   deno run -A --node-modules-dir=none supabase/functions/_warmup/testing/migration-check.ts
//
// Run this after ANY edit to the migration, and before asking for the migration-approved label.
// Only pgvector is stubbed (not bundled with PGlite); it is already proven in this project by
// migration 20260427203208.

import { bootWarmupDb } from "./pglite-client.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); }
};

const { db } = await bootWarmupDb();
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];

/** Asserts a statement is refused, and that the refusal says what we expect. */
const rejects = async (name: string, sql: string, match?: string) => {
  try { await db.exec(sql); ok(name, false, "the statement was ACCEPTED — the invariant is not enforced"); }
  catch (e) {
    const m = String((e as Error).message);
    ok(name, match ? m.includes(match) : true, m.split("\n")[0].slice(0, 110));
  }
};

console.log("engine:", (await q("select version() v"))[0].v.split(",")[0], "\n");

console.log("=== objects ===");
const tables = await q(
  `select table_name from information_schema.tables where table_schema='warmup' and table_type='BASE TABLE' order by 1`);
ok("12 tables", tables.length === 12, tables.map((r) => r.table_name).join(" "));
const views = await q(`select table_name from information_schema.views where table_schema='warmup' order by 1`);
ok("2 views", views.length === 2, views.map((r) => r.table_name).join(" "));

console.log("\n=== DELTA-6  ledger is append-only, enforced by the database ===");
await db.exec(`INSERT INTO warmup.ledger (telegram_id,action,points,plugin,dedupe_key)
               VALUES (11,'reaction',1,'points-basic','k1'),(11,'comment',2,'points-basic','k2');`);
await rejects("UPDATE is refused", `UPDATE warmup.ledger SET points=999 WHERE dedupe_key='k1'`, "append-only");
await rejects("DELETE is refused", `DELETE FROM warmup.ledger WHERE dedupe_key='k1'`, "append-only");
// A row-level trigger does not see TRUNCATE; without the statement-level trigger this is a hole
// wide enough to empty the table.
await rejects("TRUNCATE is refused", `TRUNCATE warmup.ledger`, "append-only");
const after = await q(`select count(*)::int n, sum(points)::int s from warmup.ledger`);
ok("the ledger is unchanged after all three", after[0].n === 2 && after[0].s === 3,
   `${after[0].n} rows, ${after[0].s} points`);
await rejects("dedupe_key is unique — one award per key",
  `INSERT INTO warmup.ledger (telegram_id,action,points,plugin,dedupe_key)
   VALUES (11,'reaction',1,'points-basic','k1')`, "duplicate key");

console.log("\n=== DELTA-4  plugin_state holds plugin-global state (telegram_id NULL) ===");
await db.exec(`INSERT INTO warmup.plugin_state (plugin,telegram_id,key,value)
               VALUES ('streaks',NULL,'global','{"a":1}'::jsonb), ('streaks',77,'per_user','{"b":2}'::jsonb);`);
const ps = await q(`select telegram_id, scope_id from warmup.plugin_state order by scope_id`);
ok("global row keeps telegram_id NULL and scope_id -1",
   ps[0].telegram_id === null && Number(ps[0].scope_id) === -1, JSON.stringify(ps));
await rejects("a duplicate global key is refused",
  `INSERT INTO warmup.plugin_state (plugin,telegram_id,key,value) VALUES ('streaks',NULL,'global','{}'::jsonb)`,
  "duplicate key");
await db.exec(`INSERT INTO warmup.plugin_state (plugin,telegram_id,key,value)
               VALUES ('streaks',NULL,'global','{"a":42}'::jsonb)
               ON CONFLICT (plugin,scope_id,key) DO UPDATE SET value=EXCLUDED.value;`);
ok("upsert on the generated-column key works",
   (await q(`select value from warmup.plugin_state where key='global'`))[0].value.a === 42);

console.log("\n=== DELTA-1  replay dedupe, via the exact ON CONFLICT PostgREST emits ===");
// supabase-js sends on_conflict=update_id,event_type. If the index were partial, Postgres would
// reject this form outright and ingestion would fail on every update.
const ins = (u: number | null, t: string) => db.query(
  `INSERT INTO warmup.events (event_type,telegram_id,payload,update_id)
   VALUES ($1,11,'{}'::jsonb,$2) ON CONFLICT (update_id, event_type) DO NOTHING RETURNING id`, [t, u]);
ok("first arrival inserts", (await ins(5001, "reaction.added")).rows.length === 1);
ok("a redelivery inserts nothing", (await ins(5001, "reaction.added")).rows.length === 0);
ok("one update fanning out to two event types inserts both",
   (await ins(5002, "media.submitted")).rows.length === 1 &&
   (await ins(5002, "task.completed")).rows.length === 1);
const nulls = [await ins(null, "day.started"), await ins(null, "day.started")];
ok("engine-emitted rows (NULL update_id) are unconstrained — NULLS DISTINCT",
   nulls.every((r) => r.rows.length === 1));

console.log("\n=== DELTA-7  ranks break ties deterministically ===");
await db.exec(`INSERT INTO warmup.ledger (telegram_id,action,points,plugin,dedupe_key,created_at) VALUES
  (20,'seed',50,'t','t20','2026-09-01T10:00:00Z'),
  (21,'seed',50,'t','t21','2026-09-01T09:00:00Z'),
  (22,'seed',50,'t','t22','2026-09-01T11:00:00Z'),
  (23,'seed',90,'t','t23','2026-09-01T12:00:00Z');`);
const ranked = await q(`select telegram_id, rank from warmup.ranks where telegram_id>=20 order by rank`);
const order = ranked.map((r) => `${r.telegram_id}:${r.rank}`).join(" ");
ok("a three-way tie is fully ordered, no duplicate ranks",
   new Set(ranked.map((r) => Number(r.rank))).size === ranked.length, order);
ok("the earliest achiever wins the tie", order.startsWith("23:1 21:2 20:3 22:4"), order);

console.log("\n=== one active pack at a time ===");
await db.exec(`INSERT INTO warmup.campaign_pack (version,pack,status) VALUES ('v1','{}'::jsonb,'active');`);
await rejects("a second active pack is refused",
  `INSERT INTO warmup.campaign_pack (version,pack,status) VALUES ('v2','{}'::jsonb,'active')`, "duplicate key");
await db.exec(`INSERT INTO warmup.campaign_pack (version,pack,status) VALUES ('v3','{}'::jsonb,'draft');`);
ok("non-active packs are unconstrained",
   (await q(`select count(*)::int n from warmup.campaign_pack`))[0].n === 2);

console.log("\n=== DELTA-9 / DELTA-8  RLS and view security ===");
const rls = await q(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='warmup' and c.relkind='r'`);
ok("RLS is on for all 12 tables",
   rls.length === 12 && rls.every((r) => r.relrowsecurity),
   rls.filter((r) => !r.relrowsecurity).map((r) => r.relname).join(" ") || "all 12");
ok("zero policies — deny by default",
   (await q(`select count(*)::int n from pg_policies where schemaname='warmup'`))[0].n === 0);
// Without security_invoker a PG15+ view runs as its owner and reads straight through the RLS on
// warmup.ledger, handing any caller who reaches the schema a full leaderboard.
const vopts = await q(`select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='warmup' and c.relkind='v' order by 1`);
for (const v of vopts) {
  ok(`${v.relname} has security_invoker=true`,
     (v.reloptions || []).some((o: string) => o.replace(/\s/g, "") === "security_invoker=true"),
     JSON.stringify(v.reloptions));
}

console.log("\n=== grants: service_role only ===");
for (const [role, want] of [["service_role", true], ["anon", false], ["authenticated", false]] as const) {
  ok(`${role} USAGE on schema warmup = ${want}`,
     (await q(`select has_schema_privilege($1,'warmup','USAGE') u`, [role]))[0].u === want);
}
ok("service_role can INSERT into warmup.ledger",
   (await q(`select has_table_privilege('service_role','warmup.ledger','INSERT') i`))[0].i === true);
ok("anon cannot SELECT warmup.ledger",
   (await q(`select has_table_privilege('anon','warmup.ledger','SELECT') s`))[0].s === false);

console.log(`\n${"=".repeat(58)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(58)}`);
if (fail) Deno.exit(1);
